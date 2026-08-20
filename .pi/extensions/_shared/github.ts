const githubName = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?";
const pullRequestUrlPattern = new RegExp(
  `^https://github\\.com/(${githubName})/(${githubName})/pull/([1-9][0-9]{0,9})(?:[/?#].*)?$`,
);
const embeddedPullRequestUrlPattern = new RegExp(
  `https://github\\.com/${githubName}/${githubName}/pull/[1-9][0-9]{0,9}(?![0-9])`,
);

export interface GitHubPullRequestReference {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestReference | undefined {
  const match = value.match(pullRequestUrlPattern);
  if (!match) return undefined;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    number,
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}

export function extractGitHubPullRequestUrl(text: string): string | undefined {
  return text.match(embeddedPullRequestUrlPattern)?.[0];
}
