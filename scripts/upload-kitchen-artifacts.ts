import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

type EnvKey =
  | "R2_ENDPOINT"
  | "R2_ACCESS_KEY_ID"
  | "R2_SECRET_ACCESS_KEY"
  | "R2_BUCKET";

const requiredEnv = (key: EnvKey): string => {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return value;
};

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

const toPosixKey = (baseDir: string, filePath: string): string =>
  relative(baseDir, filePath).split(sep).join("/");

async function main() {
  const artifactsDir = Bun.argv[2];
  if (!artifactsDir) {
    console.error("Usage: bun run scripts/upload-kitchen-artifacts.ts -- <artifactsDir>");
    process.exit(1);
  }

  // Validate directory exists
  try {
    const stats = await stat(artifactsDir);
    if (!stats.isDirectory()) {
      console.error(`Provided path is not a directory: ${artifactsDir}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Cannot access artifacts directory "${artifactsDir}":`, error);
    process.exit(1);
  }

  const endpoint = requiredEnv("R2_ENDPOINT");
  const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
  const bucket = requiredEnv("R2_BUCKET");

  const client = new Bun.S3Client({
    accessKeyId,
    secretAccessKey,
    endpoint,
    region: "auto",
    bucket,
  });

  console.log(`Uploading artifacts from ${artifactsDir} to bucket ${bucket}`);

  const files: string[] = [];
  for await (const filePath of walk(artifactsDir)) {
    files.push(filePath);
  }

  if (files.length === 0) {
    console.warn("No files found to upload.");
    return;
  }

  const concurrency = 5;

  console.log(`Uploading ${files.length} files with concurrency ${concurrency}`);

  let uploadedCount = 0;
  let failedCount = 0;
  let nextIndex = 0;

  const uploadFile = async (filePath: string) => {
    const key = toPosixKey(artifactsDir, filePath);
    const file = Bun.file(filePath);
    const size = file.size ?? "unknown";

    console.log(`  ${key} (${size} bytes)`);

    await client.write(
      key,
      file,
      file.type ? { type: file.type } : undefined,
    );

    uploadedCount += 1;
  };

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      const filePath = files[index];
      if (!filePath) break;

      try {
        await uploadFile(filePath);
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to upload ${filePath}:`, error);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, () => worker()),
  );

  if (failedCount > 0) {
    console.error(`${failedCount} file(s) failed to upload.`);
    process.exit(1);
  }

  console.log(`Uploaded ${uploadedCount} file(s) to R2.`);
}

await main().catch((error) => {
  console.error("Upload failed:", error);
  process.exit(1);
});
