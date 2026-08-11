export const authTypeDefs = `#graphql
  """
  Authenticated user information
  """
  type User {
    id: ID!
    email: String
    name: String
    emailVerified: Boolean!
    image: String
    fplEntryId: Int
		fplEntryVerifiedAt: String
  }

  extend type Query {
    """
    Get current authenticated user
    Returns null if not authenticated
    """
    me: User
  }
`;
