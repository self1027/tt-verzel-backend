import { externalProductSchema } from '../../modules/catalog/infrastructure/dummyjson-schemas.js';

// Public whitelist copied from tests/fixtures/dummyjson/product_1.json.
// Kept inside src so the compiled Docker image needs neither test files nor HTTP.
export const demoProduct = externalProductSchema.parse({
  id: 1,
  title: 'Essence Mascara Lash Princess',
  description: 'The Essence Mascara Lash Princess is a popular mascara known for its volumizing and lengthening effects. Achieve dramatic lashes with this long-lasting and cruelty-free formula.',
  thumbnail: 'https://cdn.dummyjson.com/product-images/beauty/essence-mascara-lash-princess/thumbnail.webp',
  category: 'beauty', brand: 'Essence', sku: 'BEA-ESS-ESS-001', tags: ['beauty', 'mascara'],
});
