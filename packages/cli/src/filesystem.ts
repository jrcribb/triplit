import path from 'path';
import fs, { existsSync, readFileSync } from 'fs';
import ts from 'typescript';

export function createDirIfNotExists(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const CWD = process.cwd();

export const TRIPLIT_DIR = path.join(CWD, 'triplit');
export function getTriplitDir() {
  createDirIfNotExists(TRIPLIT_DIR);
  return TRIPLIT_DIR;
}

export const MIGRATIONS_DIR = path.join(TRIPLIT_DIR, 'migrations');

export const SEED_DIR = path.join(TRIPLIT_DIR, 'seeds');

export function getMigrationsDir() {
  createDirIfNotExists(MIGRATIONS_DIR);
  return MIGRATIONS_DIR;
}

export function getSeedsDir() {
  createDirIfNotExists(SEED_DIR);
  return SEED_DIR;
}

// Contains data for the local db if in filesystem (ie sqlite)
export const DATA_DIR = path.join(TRIPLIT_DIR, '.data');
export function getDataDir() {
  createDirIfNotExists(DATA_DIR);
  return DATA_DIR;
}

export function transpileTsFile(filename: string) {
  const source = fs.readFileSync(filename, 'utf8');
  return transpileTsString(source);
}

export function transpileTsString(source: string) {
  const isModule = isCallerModule();
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: isModule ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
    },
  });
  return result.outputText;
}

function findClosestPackageJson(startPath: string) {
  let dir = startPath;
  while (dir !== path.parse(dir).root) {
    const potentialPath = path.join(dir, 'package.json');
    if (fs.existsSync(potentialPath)) {
      return potentialPath;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function getModuleType(callerPath: string) {
  const packageJsonPath = findClosestPackageJson(callerPath);

  if (!packageJsonPath) {
    // default to commonjs
    return 'commonjs';
  }

  const packageData = fs.readFileSync(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageData);

  return packageJson.type === 'module' ? 'esm' : 'commonjs';
}

function isCallerModule() {
  return getModuleType(process.cwd()) === 'esm';
}

// Within a process, break the import cache in case of file changes
// I'd rather not do this, but had issues with tests not picking up changes
export async function importFresh(modulePath: string) {
  const cacheBustingModulePath = `${modulePath}?update=${Date.now()}`;
  return await import(cacheBustingModulePath);
}

export async function loadTsModule(filepath: string) {
  if (!filepath.endsWith('.ts')) throw new Error('File must be a .ts file');
  const absolutePath = path.resolve(filepath);
  const dir = path.dirname(absolutePath);
  const filename = path.basename(absolutePath, '.ts');
  const tmpDir = path.join(dir, 'tmp');
  const transpiledJsPath = path.join(tmpDir, `_${filename}.js`);
  try {
    if (!fs.existsSync(absolutePath)) return undefined;
    const transpiledJs = transpileTsFile(absolutePath);
    fs.mkdirSync(path.dirname(transpiledJsPath), { recursive: true });
    fs.writeFileSync(transpiledJsPath, transpiledJs, 'utf8');
    const result = await importFresh('file:///' + transpiledJsPath);
    return result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function inferProjectName() {
  let name = path.basename(CWD);
  const packageJsonPath = CWD + '/package.json';
  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (packageJson.name) {
      name = packageJson.name;
    }
  }
  return name;
}
