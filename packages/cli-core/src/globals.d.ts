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

/** Files the Android starter embeds and copies into a new project (Bun's `type: "file"` import). */
declare module "*/starter/gradle-wrapper.jar" {
  const path: string;
  export default path;
}
declare module "*/starter/gradlew" {
  const path: string;
  export default path;
}
declare module "*/starter/gradlew.bat" {
  const path: string;
  export default path;
}
