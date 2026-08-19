/**
 * Base GraphQL schema
 * Defines the read-only root Query type that domains can extend.
 */

export const baseTypeDefs = `#graphql
  type Query {
    _empty: String
  }
`;

export const baseResolvers = {
	Query: {
		_empty: (): string | null => null,
	},
};
