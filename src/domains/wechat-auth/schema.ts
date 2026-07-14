export const wechatAuthTypeDefs = `#graphql
  type ApiSessionUser {
    id: ID!
    fplEntryId: Int
  }

  type ApiSession {
    token: String!
    expiresAt: String!
    user: ApiSessionUser!
  }

  extend type Mutation {
    """
    Exchanges a wx.login() code for a backend API session token.
    The token is issued by this backend and must be sent as Authorization: Bearer <token>.
    """
    createWechatApiSession(code: String!, fplEntryId: Int): ApiSession!

    """
    Deprecated: prefer createWechatApiSession.
    Exchanges wx.login() code for OpenID and ensures a user row exists.
    Requires authentication. Does not bind fplEntryId (use bindFplEntry).
    """
    identifyWechatUser(code: String!): String!

    """
    Called by authenticated website users to set their FPL team ID.
    """
    bindFplEntry(fplEntryId: Int!): Boolean!
  }
`;
