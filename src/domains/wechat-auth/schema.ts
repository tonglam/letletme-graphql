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
    Called by the miniprogram on launch and on team ID change.
    Exchanges wx.login() code for OpenID, ensures a user row exists,
    and links to the first authenticated website user sharing the same fplEntryId.
    Returns the stable OpenID.
    """
    identifyWechatUser(code: String!, fplEntryId: Int): String!

    """
    Called by authenticated website users to set their FPL team ID.
    """
    bindFplEntry(fplEntryId: Int!): Boolean!
  }
`;
