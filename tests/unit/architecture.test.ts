import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Every module specifier a file imports or re-exports. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

describe('architecture', () => {
  describe('src/graph-engine is plain TypeScript', () => {
    const files = sourceFiles(join(__dirname, '../../src/graph-engine'));

    it('has files to check', () => {
      expect(files.length).toBeGreaterThanOrEqual(6);
    });

    it.each(files.map((file) => [file.slice(file.indexOf('src/')), file] as const))(
      '%s imports only from inside the engine',
      (_name, file) => {
        for (const specifier of importsOf(file)) {
          // Allowed: a sibling file of the engine. Anything else (express, zod, prisma, the feature
          // modules, http, infrastructure, node built-ins) would tie the engine to a framework.
          expect({ file: _name, specifier, allowed: /^\.\/[\w-]+$/.test(specifier) }).toEqual({
            file: _name,
            specifier,
            allowed: true,
          });
        }
      },
    );
  });

  describe('the rule language does not depend on the web layer or the database', () => {
    const files = sourceFiles(join(__dirname, '../../src/modules/filters/rules'));

    it.each(files.map((file) => [file.slice(file.indexOf('src/')), file] as const))('%s', (_name, file) => {
      const forbidden = importsOf(file).filter((specifier) => /express|prisma|generated|infrastructure|\/graphs\//.test(specifier));

      expect(forbidden).toEqual([]);
    });
  });

  describe('there is a single PrismaClient per process', () => {
    const root = join(__dirname, '../..');
    const files = [...sourceFiles(join(root, 'src')).filter((f) => !f.includes('/generated/')), ...sourceFiles(join(root, 'scripts'))];
    const where = (pattern: RegExp): string[] =>
      files.filter((file) => pattern.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length + 1)).sort();

    it('only infrastructure/prisma.ts constructs a PrismaClient', () => {
      expect(where(/new PrismaClient\(/)).toEqual(['src/infrastructure/prisma.ts']);
    });

    it('application code never calls the factory that builds an extra client', () => {
      expect(where(/createPrismaClient\(/)).toEqual(['src/infrastructure/prisma.ts']);
    });

    it('only the entry points that own the process ask for the shared client', () => {
      expect(where(/getPrismaClient\(/)).toEqual(['scripts/seed.ts', 'src/container.ts', 'src/infrastructure/prisma.ts']);
    });
  });
});
