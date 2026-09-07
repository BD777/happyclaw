import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const space = fs.statfsSync(root);
const freeGiB = (space.bavail * space.bsize) / 1024 ** 3;
if (freeGiB < 2)
  throw new Error(
    `Only ${freeGiB.toFixed(2)} GiB free; restore at least 2 GiB before deploying`,
  );
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
  throw new Error('Commit changes before deployment');
const image = process.argv[2];
if (image) {
  const details = JSON.parse(
    execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }),
  )[0];
  if (details.Config.Labels?.['org.opencontainers.image.revision'] !== sha)
    throw new Error('Image revision does not match Git HEAD');
  console.log(
    JSON.stringify({
      sha,
      imageId: details.Id,
      freeGiB: Number(freeGiB.toFixed(2)),
    }),
  );
} else
  console.log(JSON.stringify({ sha, freeGiB: Number(freeGiB.toFixed(2)) }));
