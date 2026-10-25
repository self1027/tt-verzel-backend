# Fixtures DummyJSON

Derivadas dos seis JSONs reais em `temp/dummyjson_responses/`, sem alterar os originais.
O script original consulta categorias por meio de `/products/category-list` (lista de slugs),
e não `/products/categories` (lista de objetos).

- As respostas mantêm total, skip e limit observados; as páginas foram reduzidas a dois
  produtos para manter fixtures pequenas. O mock HTTP ajusta skip/limit ao pedido.
- `products` inclui um produto sem brand, observado na resposta original.
- `product_1` preserva os campos consumidos pelo provider e um preço externo para
  testar que ele não é propagado.
- As avaliações reais foram substituídas por uma avaliação sintética com e-mail .invalid;
  os testes garantem que ela não seja retornada nem persistida.
- Outros campos não utilizados foram removidos. Estas fixtures não são acessadas
  pelo código de produção.
