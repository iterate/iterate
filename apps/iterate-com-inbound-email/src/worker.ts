// apps/iterate-com-inbound-email — iterate.com's inbound mail. The Email Routing catch-all on the
// iterate.com zone delivers every message for *@iterate.com here, and for now each one is forwarded
// to Jonas. `forward` reaches only a destination address verified on the account (Email Routing →
// Destination addresses).
export default {
  async email(message: ForwardableEmailMessage) {
    await message.forward("jonas@nustom.com");
  },
} satisfies ExportedHandler;
