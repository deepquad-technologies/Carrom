const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * The mobile app lives in a monorepo and imports TypeScript source directly
 * from ../../packages. Metro needs to be told to watch those folders and where
 * to look for modules, or it resolves neither.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(workspaceRoot, 'packages')];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Resolve the shared packages to their TypeScript entry points.
config.resolver.extraNodeModules = {
  '@carrom/types': path.resolve(workspaceRoot, 'packages/types/src'),
  '@carrom/config': path.resolve(workspaceRoot, 'packages/config/src'),
  '@carrom/physics': path.resolve(workspaceRoot, 'packages/physics/src'),
  '@carrom/game-engine': path.resolve(workspaceRoot, 'packages/game-engine/src'),
  '@carrom/content': path.resolve(workspaceRoot, 'packages/content/src'),
  '@carrom/ui': path.resolve(workspaceRoot, 'packages/ui/src'),
};

// Hoisted dependencies must not be duplicated, or React breaks.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
