import { demoProduct } from './demo-product.js';

// Local demonstration catalog; no dependency on the external API at seed time.
const catalog = [
  ['Batom Red Lipstick', 'beauty', 'beauty/red-lipstick', 'Batom vermelho de acabamento cremoso.'],
  ['Paleta de sombras', 'beauty', 'beauty/eyeshadow-palette-with-mirror', 'Paleta com espelho e tons para uso diário.'],
  ['Pó compacto', 'beauty', 'beauty/powder-canister', 'Pó facial para acabamento uniforme.'],
  ['Esmalte vermelho', 'beauty', 'beauty/red-nail-polish', 'Esmalte de cor intensa e acabamento brilhante.'],
  ['Perfume Calvin Klein CK One', 'fragrances', 'fragrances/calvin-klein-ck-one', 'Fragrância cítrica unissex para o dia a dia.'],
  ['Perfume Chanel Coco Noir', 'fragrances', 'fragrances/chanel-coco-noir-eau-de', 'Fragrância sofisticada de notas amadeiradas.'],
  ['Perfume Dior J’adore', 'fragrances', 'fragrances/dior-jadore', 'Fragrância floral em frasco de vidro.'],
  ['Perfume Dolce Shine', 'fragrances', 'fragrances/dolce-shine-eau-de', 'Fragrância floral e frutada.'],
  ['Perfume Gucci Bloom', 'fragrances', 'fragrances/gucci-bloom-eau-de', 'Fragrância floral para ocasiões especiais.'],
  ['Cama Annibale Colombo', 'furniture', 'furniture/annibale-colombo-bed', 'Cama de madeira com cabeceira estofada.'],
  ['Sofá Annibale Colombo', 'furniture', 'furniture/annibale-colombo-sofa', 'Sofá para sala de estar com acabamento em madeira.'],
  ['Mesa de cabeceira', 'furniture', 'furniture/bedside-table-african-cherry', 'Mesa auxiliar com gavetas em tom cerejeira.'],
  ['Cadeira de escritório', 'furniture', 'furniture/knoll-saarinen-executive-conference-chair', 'Cadeira estofada para escritório ou sala de reuniões.'],
  ['Penteadeira com espelho', 'furniture', 'furniture/wooden-bathroom-sink-with-mirror', 'Móvel de madeira com espelho e espaço de armazenamento.'],
  ['Cesta de maçãs', 'groceries', 'groceries/apple', 'Lote de maçãs selecionadas para consumo.'],
  ['Pacote de carne bovina', 'groceries', 'groceries/beef-steak', 'Cortes bovinos embalados para preparo.'],
  ['Ração para gatos', 'groceries', 'groceries/cat-food', 'Pacote de alimento seco para gatos adultos.'],
  ['Frango inteiro', 'groceries', 'groceries/chicken-meat', 'Frango embalado para preparo culinário.'],
  ['Óleo de cozinha', 'groceries', 'groceries/cooking-oil', 'Garrafa de óleo vegetal para uso culinário.'],
  ['Pepinos selecionados', 'groceries', 'groceries/cucumber', 'Lote de pepinos frescos para saladas.'],
  ['Ração para cães', 'groceries', 'groceries/dog-food', 'Pacote de alimento seco para cães adultos.'],
  ['Ovos de granja', 'groceries', 'groceries/eggs', 'Bandeja de ovos para uso culinário.'],
  ['Filés de peixe', 'groceries', 'groceries/fish-steak', 'Lote de filés de peixe embalados.'],
] as const;

export const demoProducts = [demoProduct, ...catalog.map(([title, category, image, description], index) => ({
  id: index + 2, title, description,
  imageUrl: `https://cdn.dummyjson.com/product-images/${image}/thumbnail.webp`,
  attributes: { category, sku: `DEMO-${String(index + 2).padStart(3, '0')}`, tags: [category] },
}))];
