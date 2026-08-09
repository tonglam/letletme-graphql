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
    createWechatApiSession(code: String!): ApiSession!
  }
`;
