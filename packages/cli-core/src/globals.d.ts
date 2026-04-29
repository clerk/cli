declare module "*.md" {
  const content: string;
  export default content;
}

declare const CLI_VERSION: string | undefined;

declare const CLI_ENV_PROFILES:
  | Record<
      string,
      {
        oauthClientId: string;
        oauthBaseUrl: string;
        platformApiUrl: string;
        backendApiUrl: string;
      }
    >
  | undefined;
