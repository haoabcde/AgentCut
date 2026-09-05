const reviewReasonLabels: Readonly<Record<string, string>> = {
  silence: "停顿",
  filler: "语气词",
  stutter: "口吃",
  repetition: "重复",
  false_start: "说到一半重来",
  restatement: "重说",
  correction: "说错纠正",
  incomplete: "未完成表达",
  manual: "人工标记",
};

export function reviewReasonLabel(reason: string): string {
  return reviewReasonLabels[reason] ?? reason;
}

export function reviewReasonList(reasons: string[], separator = " · "): string {
  return reasons.map(reviewReasonLabel).join(separator);
}
