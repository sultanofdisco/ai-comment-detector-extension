export interface AccountRecentComment {
  commentId: string | null;
  url: string;
  text: string;
  languageCode: string;
  aiScore: number | null;
  exceedsThreshold: boolean;
}

export interface AccountProfile {
  handle: string;
  totalComments: number;
  languageDistribution: Record<string, number>;
  uniqueLanguageCount: number;
  koreanCommentCount: number;
  aiSuspicion: {
    mean: number;
    max: number;
    // Calculated from up to the first 5 Korean replies collected from with_replies.
    highRatioAboveThreshold: number;
  };
  recentComments: AccountRecentComment[];
  verdict: "suspicious" | "borderline" | "likely_human";
}
