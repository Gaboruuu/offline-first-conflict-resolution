// Learn more https://docs.expo.dev/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Yjs (through lib0) loads `lib0/webcrypto`, whose React Native build needs `isomorphic-webcrypto`;
// the app gives it a small stand-in on top of expo-crypto instead (see src/sync/webcrypto.ts).
const WEBCRYPTO_SHIM = path.resolve(__dirname, 'src/sync/webcrypto.ts');
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'lib0/webcrypto') return { type: 'sourceFile', filePath: WEBCRYPTO_SHIM };
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
