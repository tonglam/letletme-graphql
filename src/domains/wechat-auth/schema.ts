export const wechatAuthTypeDefs = `#graphql
  extend type Mutation {
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
