import type { Env } from "../config/env.js";

export interface ResearchResult {
  query: string;
  answer: string;
  sources: string[];
}

export class ResearcherAgent {
  private apiKey: string | undefined;

  constructor(env: Env) {
    this.apiKey = env.PERPLEXITY_API_KEY;
  }

  isAvailable(): boolean {
    return this.apiKey !== undefined;
  }

  async research(query: string): Promise<ResearchResult> {
    if (!this.apiKey) {
      return {
        query,
        answer: "Perplexity API key not configured. Skipping research.",
        sources: [],
      };
    }

    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          {
            role: "system",
            content:
              "You are a technical research assistant. Provide concise, accurate answers with source URLs. Focus on official documentation and recent, reliable sources.",
          },
          { role: "user", content: query },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      citations?: string[];
    };

    return {
      query,
      answer: data.choices[0]?.message?.content ?? "No answer received.",
      sources: data.citations ?? [],
    };
  }
}
