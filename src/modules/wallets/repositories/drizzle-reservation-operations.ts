import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { users } from '../../users/infrastructure/schema.js';
import { ledgerAccounts, ledgerTransactions } from '../../ledger/infrastructure/schema.js';
import { DrizzleLedgerRepository } from '../../ledger/repositories/drizzle-ledger-repository.js';
import type { Reservation, ReservationOperations } from '../contracts/reservations.js';
import { wallets, walletReservations } from '../infrastructure/schema.js';

const MAX_CENTS = 9223372036854775807n;
const databaseNow = sql<Date>`date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')`;

export interface ReservationWallet {
  id: string;
  userId: string;
  balanceCents: bigint;
  reservedCents: bigint;
}

/** Acquire actual row locks in UUID order, before any reservation row locks. */
export async function lockReservationWallets(tx: DatabaseTransaction, walletIds: string[]): Promise<ReservationWallet[]> {
  const result: ReservationWallet[] = [];
  for (const id of [...new Set(walletIds)].sort()) {
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, id)).for('update');
    if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
    if (wallet.balanceCents < 0n || wallet.balanceCents > MAX_CENTS
      || wallet.reservedCents < 0n || wallet.reservedCents > wallet.balanceCents) {
      throw new AppError(409, 'INVALID_WALLET_STATE', 'Wallet balances are inconsistent');
    }
    const active = await tx.select({ amount: walletReservations.amountCents }).from(walletReservations)
      .where(and(eq(walletReservations.walletId, id), eq(walletReservations.status, 'ACTIVE')));
    if (active.some((row) => row.amount <= 0n || row.amount > MAX_CENTS)
      || active.reduce((sum, row) => sum + row.amount, 0n) !== wallet.reservedCents) {
      throw new AppError(409, 'INVALID_WALLET_STATE', 'Wallet reservations are inconsistent');
    }
    result.push({ id: wallet.id, userId: wallet.userId, balanceCents: wallet.balanceCents, reservedCents: wallet.reservedCents });
  }
  return result;
}

async function lockAuction(tx: DatabaseTransaction, auctionId: string) {
  const [auction] = await tx.select({ id: auctions.id, auctioneerId: auctions.auctioneerId }).from(auctions).where(eq(auctions.id, auctionId)).for('update');
  if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  return auction;
}

function conflict(): never {
  throw new AppError(409, 'RESERVATION_CONFLICT', 'Reservation terms or state conflict');
}

export class DrizzleReservationOperations implements ReservationOperations {
  async captureReservation(tx: DatabaseTransaction, input: {
    reservationId: string; recipientWalletId: string; idempotencyKey: string;
  }): Promise<Reservation> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(input.idempotencyKey)) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid capture idempotency key');
    }
    const [located] = await tx.select().from(walletReservations).where(eq(walletReservations.id, input.reservationId));
    if (!located) throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
    const auction = await lockAuction(tx, located.auctionId);
    const locked = await lockReservationWallets(tx, [located.walletId, input.recipientWalletId]);
    const [reservation] = await tx.select().from(walletReservations)
      .where(eq(walletReservations.id, input.reservationId)).for('update');
    if (!reservation || reservation.walletId !== located.walletId || reservation.auctionId !== located.auctionId
      || reservation.bidId !== located.bidId || reservation.amountCents <= 0n || reservation.amountCents > MAX_CENTS
      || reservation.status === 'RELEASED' || reservation.releasedAt !== null) conflict();
    const winner = locked.find(wallet => wallet.id === reservation.walletId);
    const recipient = locked.find(wallet => wallet.id === input.recipientWalletId);
    const [bid] = await tx.select().from(bids).where(eq(bids.id, reservation.bidId));
    if (!winner || !recipient || winner.id === recipient.id || !bid || bid.auctionId !== auction.id
      || bid.bidderId !== winner.userId || bid.amountCents !== reservation.amountCents
      || recipient.userId !== auction.auctioneerId) conflict();
    const [bidder] = await tx.select({ role: users.role }).from(users).where(eq(users.id, winner.userId));
    const [seller] = await tx.select({ role: users.role }).from(users).where(eq(users.id, recipient.userId));
    if (bidder?.role !== 'BIDDER' || seller?.role !== 'AUCTIONEER') conflict();

    const [winnerAccount] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.walletId, winner.id));
    const [recipientAccount] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.walletId, recipient.id));
    if (!winnerAccount || !recipientAccount || winnerAccount.type !== 'USER_WALLET' || recipientAccount.type !== 'USER_WALLET') {
      throw new AppError(409, 'INVALID_WALLET_STATE', 'Wallet ledger accounts are inconsistent');
    }
    const ledger = new DrizzleLedgerRepository(tx);
    if (await ledger.balance(winnerAccount.id) !== winner.balanceCents
      || await ledger.balance(recipientAccount.id) !== recipient.balanceCents) {
      throw new AppError(409, 'INVALID_WALLET_STATE', 'Wallet balances do not reconcile with the ledger');
    }
    const previous = await ledger.findByKey(input.idempotencyKey);
    const references = await tx.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.referenceId, reservation.id));
    if (reservation.status === 'CAPTURED') {
      if (!previous || previous.transaction.type !== 'AUCTION_SETTLEMENT'
        || previous.transaction.referenceId !== reservation.id || references.length !== 1
        || references[0]?.id !== previous.transaction.id || previous.entries.length !== 2
        || previous.entries.filter(entry => entry.accountId === winnerAccount.id && entry.amountCents === -reservation.amountCents).length !== 1
        || previous.entries.filter(entry => entry.accountId === recipientAccount.id && entry.amountCents === reservation.amountCents).length !== 1) conflict();
      return reservation;
    }
    if (previous || references.length !== 0) conflict();
    if (winner.reservedCents < reservation.amountCents || winner.balanceCents < reservation.amountCents
      || recipient.balanceCents + reservation.amountCents > MAX_CENTS) {
      throw new AppError(409, 'INVALID_WALLET_STATE', 'Capture would violate wallet balances');
    }
    await ledger.append({ id: randomUUID(), type: 'AUCTION_SETTLEMENT', referenceId: reservation.id,
      idempotencyKey: input.idempotencyKey, createdAt: new Date() }, [
      { accountId: winnerAccount.id, amountCents: -reservation.amountCents },
      { accountId: recipientAccount.id, amountCents: reservation.amountCents },
    ]);
    await tx.update(wallets).set({ balanceCents: winner.balanceCents - reservation.amountCents,
      reservedCents: winner.reservedCents - reservation.amountCents, updatedAt: databaseNow }).where(eq(wallets.id, winner.id));
    await tx.update(wallets).set({ balanceCents: recipient.balanceCents + reservation.amountCents, updatedAt: databaseNow })
      .where(eq(wallets.id, recipient.id));
    const [captured] = await tx.update(walletReservations).set({ status: 'CAPTURED' })
      .where(eq(walletReservations.id, reservation.id)).returning();
    if (!captured) conflict();
    return captured;
  }

  async reserveFunds(tx: DatabaseTransaction, input: {
    walletId: string; auctionId: string; bidId: string; amountCents: bigint;
  }): Promise<Reservation> {
    if (input.amountCents <= 0n || input.amountCents > MAX_CENTS) {
      throw new AppError(400, 'INVALID_RESERVATION_AMOUNT', 'Reservation amount must be positive and fit BIGINT');
    }
    await lockAuction(tx, input.auctionId);
    const [bid] = await tx.select().from(bids).where(eq(bids.id, input.bidId));
    if (!bid) throw new AppError(404, 'BID_NOT_FOUND', 'Bid not found');
    if (bid.auctionId !== input.auctionId || bid.amountCents !== input.amountCents) {
      throw new AppError(409, 'RESERVATION_MISMATCH', 'Reservation must match its bid and auction');
    }
    const [located] = await tx.select().from(walletReservations).where(eq(walletReservations.bidId, input.bidId));
    if (located && (located.walletId !== input.walletId || located.auctionId !== input.auctionId
      || located.amountCents !== input.amountCents || located.status !== 'ACTIVE')) conflict();
    const [wallet] = await lockReservationWallets(tx, [input.walletId]);
    if (!wallet || wallet.userId !== bid.bidderId) {
      throw new AppError(409, 'RESERVATION_MISMATCH', 'Reservation wallet must belong to the bidder');
    }
    const [user] = await tx.select({ role: users.role }).from(users).where(eq(users.id, wallet.userId));
    if (!user || user.role !== 'BIDDER') throw new AppError(403, 'BIDDER_REQUIRED', 'Only bidders can reserve funds');
    const [existing] = await tx.select().from(walletReservations).where(eq(walletReservations.bidId, input.bidId)).for('update');
    if (existing) {
      if (existing.walletId !== input.walletId || existing.auctionId !== input.auctionId
        || existing.amountCents !== input.amountCents || existing.status !== 'ACTIVE') conflict();
      return existing;
    }
    const [active] = await tx.select({ id: walletReservations.id }).from(walletReservations)
      .where(and(eq(walletReservations.auctionId, input.auctionId), eq(walletReservations.status, 'ACTIVE')));
    if (active) conflict();
    if (wallet.balanceCents - wallet.reservedCents < input.amountCents) {
      throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Insufficient available wallet funds');
    }
    const [reservation] = await tx.insert(walletReservations).values({
      id: randomUUID(), ...input, status: 'ACTIVE', createdAt: databaseNow,
    }).returning();
    await tx.update(wallets).set({ reservedCents: wallet.reservedCents + input.amountCents, updatedAt: databaseNow })
      .where(eq(wallets.id, input.walletId));
    if (!reservation) throw new AppError(409, 'RESERVATION_CONFLICT', 'Reservation could not be created');
    return reservation;
  }

  async releaseReservation(tx: DatabaseTransaction, reservationId: string): Promise<Reservation> {
    // Locate the parent without locking a child before its auction and wallet.
    const [located] = await tx.select().from(walletReservations).where(eq(walletReservations.id, reservationId));
    if (!located) throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
    await lockAuction(tx, located.auctionId);
    const [wallet] = await lockReservationWallets(tx, [located.walletId]);
    const [reservation] = await tx.select().from(walletReservations).where(eq(walletReservations.id, reservationId)).for('update');
    if (!reservation || reservation.walletId !== located.walletId || reservation.auctionId !== located.auctionId) conflict();
    if (reservation.status === 'CAPTURED') conflict();
    if (reservation.status === 'RELEASED') return reservation;
    if (!wallet || reservation.amountCents <= 0n || reservation.amountCents > wallet.reservedCents) {
      throw new AppError(409, 'INVALID_WALLET_STATE', 'Wallet reservation amount is inconsistent');
    }
    const [released] = await tx.update(walletReservations).set({ status: 'RELEASED', releasedAt: databaseNow })
      .where(eq(walletReservations.id, reservationId)).returning();
    await tx.update(wallets).set({ reservedCents: wallet.reservedCents - reservation.amountCents, updatedAt: databaseNow })
      .where(eq(wallets.id, wallet.id));
    if (!released) throw new AppError(409, 'RESERVATION_CONFLICT', 'Reservation could not be released');
    return released;
  }
}
