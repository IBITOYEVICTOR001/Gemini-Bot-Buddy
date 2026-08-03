declare module "google-auth-library" {
  export type TokenPayload = {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };

  export type LoginTicket = {
    getPayload(): TokenPayload | undefined;
  };

  export class OAuth2Client {
    verifyIdToken(options: { idToken: string; audience: string }): Promise<LoginTicket>;
  }
}
