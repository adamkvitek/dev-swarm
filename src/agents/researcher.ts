export interface ResearchResult {
  query: string;
  answer: string;
  sources: string[];
}

/**
 * Research agent — currently a stub.
 * Will be connected to Perplexity API when credits are available,
 * or routed through OpenClaw's built-in Perplexity integration.
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
