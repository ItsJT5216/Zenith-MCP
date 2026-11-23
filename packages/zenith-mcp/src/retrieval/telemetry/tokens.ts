
export const TOKEN_WEIGHTS: Record<string, number> & Record<
  "manifest:" | "lock:" | "framework:" | "lang:" | "ci:" | "container:" | "infra:" | "db:" | "vcs:" | "layout:" | "readme:",
  number
> = {
  "manifest:": 3.0,
  "lock:": 2.5,
  "framework:": 2.5,
  "lang:": 2.0,
  "ci:": 1.5,
  "container:": 1.5,
  "infra:": 1.5,
  "db:": 1.5,
  "vcs:": 1.0,
  "layout:": 0.75,
  "readme:": 0.5,
};

export const MANIFEST_LANGUAGE_MAP: Record<string, string[]> = {
  "package.json": ["javascript", "typescript", "npm", "node"],
  "Cargo.toml": ["rust", "cargo", "crate"],
  "pyproject.toml": ["python", "pip", "pypi"],
  "go.mod": ["golang", "go"],
  "pom.xml": ["java", "maven"],
  "build.gradle": ["java", "kotlin", "gradle"],
  "Gemfile": ["ruby", "gem", "bundler"],
  "composer.json": ["php", "composer"],
};

export const LOCKFILE_NAMES: Set<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
]);

const CI_PATTERN_MAP: Record<string, string> = {
  ".github/workflows": "github-actions",
  ".gitlab-ci.yml": "gitlab-ci",
  "Jenkinsfile": "jenkins",
  ".circleci": "circleci",
  ".travis.yml": "travis",
  "azure-pipelines.yml": "azure-pipelines",
  "Makefile": "make",
};

const CONTAINER_FILES: Set<string> = new Set([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

const INFRA_FILES: Set<string> = new Set([
  "terraform.tf",
  "main.tf",
  "variables.tf",
  "cloudformation.yaml",
]);

const DB_FILES: Set<string> = new Set([
  "schema.prisma",
  "schema.sql",
  "migrations",
  "alembic.ini",
]);

const MAX_FAMILY_CONTRIBUTION = 0.35;
const MAX_README_TOKENS = 20;

const TECH_WORDS_RE = /\b(docker|kubernetes|k8s|postgres|mysql|redis|mongodb|react|vue|angular|django|flask|fastapi|rails|spring|rust|golang|typescript|python|node)\b/gi;

function _extractReadmeTokens(lines: string[]): Record<string, number> {
  const found: Record<string, number> = {};
  for (const line of lines) {
    let match: RegExpExecArray | null;
    TECH_WORDS_RE.lastIndex = 0;
    while ((match = TECH_WORDS_RE.exec(line)) !== null) {
      const word = match[0].toLowerCase();
      found[word] = 1.0;
    }
  }
  return found;
}

function _applyFamilyCap(tokens: Record<string, number>): Record<string, number> {
  if (Object.keys(tokens).length === 0) return tokens;

  const result: Record<string, number> = { ...tokens };

  for (let pass = 0; pass < 5; pass++) {
    const families: Map<string, Array<[string, number]>> = new Map();
    for (const [tok, value] of Object.entries(result)) {
      const family = tok.split(":")[0] + ":";
      let members = families.get(family);
      if (members === undefined) {
        members = [];
        families.set(family, members);
      }
      members.push([tok, value]);
    }

    const currentTotal = Object.values(result).reduce((s, v) => s + v, 0);
    if (currentTotal === 0) break;

    const cap = currentTotal * MAX_FAMILY_CONTRIBUTION;
    let changed = false;

    for (const [, familyTokens] of families.entries()) {
      const familySum = familyTokens.reduce((s, [, value]) => s + value, 0);
      if (familySum > cap) {
        const scale = cap / familySum;
        for (const [tok, value] of familyTokens) {
          result[tok] = value * scale;
        }
        changed = true;
      }
    }

    if (!changed) break;
  }

  return result;
}

export function buildTokens(input: {
  foundFiles: Set<string>;
  readmeLines?: string[] | undefined;
}): Record<string, number> {
  const raw: Record<string, number> = {};

  // Manifests
  for (const filepath of input.foundFiles) {
    const basename = filepath.slice(filepath.lastIndexOf("/") + 1);
    if (MANIFEST_LANGUAGE_MAP[basename] !== undefined) {
      raw[`manifest:${basename}`] = TOKEN_WEIGHTS["manifest:"];
      for (const lang of MANIFEST_LANGUAGE_MAP[basename]) {
        raw[`lang:${lang}`] = TOKEN_WEIGHTS["lang:"];
      }
    }
  }

  // Lockfiles
  for (const filepath of input.foundFiles) {
    const basename = filepath.slice(filepath.lastIndexOf("/") + 1);
    if (LOCKFILE_NAMES.has(basename)) {
      raw[`lock:${basename}`] = TOKEN_WEIGHTS["lock:"];
    }
  }

  // CI/CD
  for (const [pattern, ciName] of Object.entries(CI_PATTERN_MAP)) {
    for (const f of input.foundFiles) {
      if (f.includes(pattern)) {
        raw[`ci:${ciName}`] = TOKEN_WEIGHTS["ci:"];
        break;
      }
    }
  }

  // Containers
  for (const f of input.foundFiles) {
    const basename = f.slice(f.lastIndexOf("/") + 1);
    if (CONTAINER_FILES.has(basename)) {
      raw[`container:${basename}`] = TOKEN_WEIGHTS["container:"];
    }
  }

  // Infra
  for (const f of input.foundFiles) {
    const basename = f.slice(f.lastIndexOf("/") + 1);
    if (INFRA_FILES.has(basename)) {
      raw[`infra:${basename}`] = TOKEN_WEIGHTS["infra:"];
    }
  }

  // DB
  for (const f of input.foundFiles) {
    const basename = f.slice(f.lastIndexOf("/") + 1);
    if (DB_FILES.has(basename)) {
      raw[`db:${basename}`] = TOKEN_WEIGHTS["db:"];
    }
  }

  // README tokens
  if (input.readmeLines) {
    const readmeTokens = _extractReadmeTokens(input.readmeLines);
    const entries = Object.entries(readmeTokens).slice(0, MAX_README_TOKENS);
    for (const [tok] of entries) {
      raw[`readme:${tok}`] = TOKEN_WEIGHTS["readme:"];
    }
  }

  return _applyFamilyCap(raw);
}

