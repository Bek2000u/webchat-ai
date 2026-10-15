
export {};
declare global {
  interface Window {
    webchatAI?: {
      getInfo(): Promise<{ version: string; origin: string; dataDir: string; extensionDir: string }>;
      openDataDirectory(): Promise<string>;
      openExtensionDirectory(): Promise<string>;
    };
  }
}
