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
    _empty: (): string | null => null,
  },
  Mutation: {
    _empty: (): string | null => null,
  },
};
