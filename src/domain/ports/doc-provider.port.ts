interface LibraryInfo {
  description: string;
  id: string;
  name: string;
  snippetCount: number;
}

interface IDocProvider {
  queryDocs(
    libraryId: string,
    topic: string,
    maxTokens?: number,
  ): Promise<string>;
  resolveLibrary(name: string, query?: string): Promise<LibraryInfo | null>;
}

export type { IDocProvider, LibraryInfo };
