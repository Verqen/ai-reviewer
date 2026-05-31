import type {
  IDocProvider,
  LibraryInfo,
} from "~/domain/ports/doc-provider.port";

class NoOpDocProvider implements IDocProvider {
  async resolveLibrary(): Promise<LibraryInfo | null> {
    return Promise.resolve(null);
  }

  async queryDocs(): Promise<string> {
    return Promise.resolve("");
  }
}

export { NoOpDocProvider };
