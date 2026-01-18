/**
 * Base GraphQL schema
 * Defines root Query and Mutation types that domains can extend
 */

export const baseTypeDefs = `#graphql
  type Query {
    _empty: String
  }

  type Mutation {
    _empty: String
  }
`;

export const baseResolvers = {
  Query: {
    _empty: () => null,
  },
  Mutation: {
    _empty: () => null,
  },
};
