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
    isAnonymous: Boolean!
  }

  """
  Device session information (for mobile)
  """
  type DeviceSession {
    id: ID!
    deviceId: String!
    deviceName: String
    deviceOs: String
    lastActive: String!
    createdAt: String!
  }

  extend type Query {
    """
    Get current authenticated user
    Returns null if not authenticated
    """
    me: User

    """
    Get all device sessions for current user
    Requires authentication
    """
    myDevices: [DeviceSession!]!
  }

  extend type Mutation {
    """
    Revoke a device session (logout device)
    Requires authentication
    """
    revokeDevice(deviceId: String!): Boolean!
  }
`;
