export interface ResearchResult {
  query: string;
  answer: string;
  sources: string[];
}

/**
 * Research agent — currently a stub.
 * Will be connected to Perplexity API when credits are available.
 * NOTE: OpenClaw integration was dropped (dangerous on host). See DECISIONS.md.
 */
export class ResearcherAgent {
  isAvailable(): boolean {
    return false;
  }

  async research(query: string): Promise<ResearchResult> {
    return {
      query,
      answer: "Research agent not yet configured. Skipping.",
      sources: [],
    };
  }
}
