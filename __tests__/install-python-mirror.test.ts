import {jest, describe, it, expect, beforeEach} from '@jest/globals';

// Inputs are read lazily by install-python.ts, so each test can set them
// before invoking the function under test.
const inputs: Record<string, string> = {};

// Mock @actions/http-client
jest.unstable_mockModule('@actions/http-client', () => ({
  HttpClient: jest.fn().mockImplementation(() => ({
    getJson: jest.fn()
  })),
  HttpClientError: class HttpClientError extends Error {},
  HttpCodes: {
    OK: 200,
    NotFound: 404,
    InternalServerError: 500
  }
}));

// Mock @actions/cache (needed transitively by utils.ts)
jest.unstable_mockModule('@actions/cache', () => ({
  saveCache: jest.fn(),
  restoreCache: jest.fn(),
  isFeatureAvailable: jest.fn()
}));

// Mock @actions/tool-cache
jest.unstable_mockModule('@actions/tool-cache', () => ({
  getManifestFromRepo: jest.fn(),
  downloadTool: jest.fn(),
  extractTar: jest.fn(),
  extractZip: jest.fn(),
  HTTPError: class HTTPError extends Error {}
}));

// Mock @actions/core (needed by install-python.ts)
jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  notice: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  getMultilineInput: jest.fn(),
  addPath: jest.fn(),
  exportVariable: jest.fn(),
  saveState: jest.fn(),
  getState: jest.fn(),
  setSecret: jest.fn(),
  isDebug: jest.fn(() => false),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  group: jest.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  toPlatformPath: jest.fn((p: string) => p),
  toWin32Path: jest.fn((p: string) => p),
  toPosixPath: jest.fn((p: string) => p)
}));

// Mock @actions/exec (needed by install-python.ts)
jest.unstable_mockModule('@actions/exec', () => ({
  exec: jest.fn(),
  getExecOutput: jest.fn()
}));

// Import real utils BEFORE mock registration to get real function references
const realUtils = await import('../src/utils.js');

// Pin the platform so the download/extract assertions below behave the same
// on every runner OS.
jest.unstable_mockModule('../src/utils.js', () => ({
  ...realUtils,
  IS_WINDOWS: false,
  IS_LINUX: false
}));

// Dynamic imports after mocking
const core = await import('@actions/core');
const httpm = await import('@actions/http-client');
const tc = await import('@actions/tool-cache');
const {
  getManifestUrl,
  getManifestFromRepo,
  getManifestFromURL,
  installCpythonFromRelease
} = await import('../src/install-python.js');

const DEFAULT_MIRROR =
  'https://raw.githubusercontent.com/actions/python-versions/main';

const mockManifest = [
  {
    version: '1.0.0',
    stable: true,
    files: [
      {
        filename: 'tool-v1.0.0-linux-x64.tar.gz',
        platform: 'linux',
        arch: 'x64',
        download_url: 'https://example.com/tool-v1.0.0-linux-x64.tar.gz'
      }
    ]
  }
];

function setInputs(values: Record<string, string>) {
  Object.assign(inputs, values);
}

beforeEach(() => {
  jest.resetAllMocks();
  for (const key of Object.keys(inputs)) {
    delete inputs[key];
  }
  (core.getInput as jest.Mock<any>).mockImplementation(
    (name: string) => inputs[name] ?? ''
  );
});

describe('getManifestUrl', () => {
  it('defaults to the actions/python-versions manifest', () => {
    expect(getManifestUrl()).toBe(`${DEFAULT_MIRROR}/versions-manifest.json`);
  });

  it('appends versions-manifest.json to a custom mirror', () => {
    setInputs({mirror: 'https://mirror.example/py'});
    expect(getManifestUrl()).toBe(
      'https://mirror.example/py/versions-manifest.json'
    );
  });

  it('strips trailing slashes from the mirror', () => {
    setInputs({mirror: 'https://mirror.example/py///'});
    expect(getManifestUrl()).toBe(
      'https://mirror.example/py/versions-manifest.json'
    );
  });

  it('throws on a mirror that is not a valid URL', () => {
    setInputs({mirror: 'not a url'});
    expect(() => getManifestUrl()).toThrow(/Invalid 'mirror' URL/);
  });
});

describe('getManifestFromRepo mirror resolution', () => {
  it('resolves the default mirror to actions/python-versions@main with token', async () => {
    setInputs({token: 'TKN'});
    (tc.getManifestFromRepo as jest.Mock<any>).mockResolvedValue(mockManifest);

    await getManifestFromRepo();

    expect(tc.getManifestFromRepo).toHaveBeenCalledWith(
      'actions',
      'python-versions',
      'token TKN',
      'main'
    );
  });

  it('extracts owner/repo/branch from a custom raw.githubusercontent.com mirror', async () => {
    setInputs({
      token: 'TKN',
      mirror: 'https://raw.githubusercontent.com/foo/bar/dev'
    });
    (tc.getManifestFromRepo as jest.Mock<any>).mockResolvedValue(mockManifest);

    await getManifestFromRepo();

    expect(tc.getManifestFromRepo).toHaveBeenCalledWith(
      'foo',
      'bar',
      'token TKN',
      'dev'
    );
  });

  it('strips a trailing slash before extracting the branch', async () => {
    setInputs({
      token: 'TKN',
      mirror: 'https://raw.githubusercontent.com/foo/bar/main/'
    });
    (tc.getManifestFromRepo as jest.Mock<any>).mockResolvedValue(mockManifest);

    await getManifestFromRepo();

    expect(tc.getManifestFromRepo).toHaveBeenCalledWith(
      'foo',
      'bar',
      'token TKN',
      'main'
    );
  });

  it('throws for a non-GitHub mirror so the caller falls back to the raw URL', () => {
    setInputs({mirror: 'https://mirror.example/py'});
    expect(() => getManifestFromRepo()).toThrow(/not a GitHub repo URL/);
    expect(tc.getManifestFromRepo).not.toHaveBeenCalled();
  });

  it('prefers mirror-token over token for the GitHub API call', async () => {
    setInputs({
      token: 'TKN',
      'mirror-token': 'MTOK',
      mirror: 'https://raw.githubusercontent.com/foo/bar/main'
    });
    (tc.getManifestFromRepo as jest.Mock<any>).mockResolvedValue(mockManifest);

    await getManifestFromRepo();

    expect(tc.getManifestFromRepo).toHaveBeenCalledWith(
      'foo',
      'bar',
      'token MTOK',
      'main'
    );
  });

  it('sends no auth when neither token nor mirror-token is set', async () => {
    (tc.getManifestFromRepo as jest.Mock<any>).mockResolvedValue(mockManifest);

    await getManifestFromRepo();

    expect(tc.getManifestFromRepo).toHaveBeenCalledWith(
      'actions',
      'python-versions',
      undefined,
      'main'
    );
  });
});

describe('getManifestFromURL mirror resolution', () => {
  it('fetches {mirror}/versions-manifest.json without attaching auth', async () => {
    setInputs({token: 'TKN', mirror: 'https://mirror.example/py'});
    const getJson = jest.fn(async () => ({result: mockManifest}));
    (httpm.HttpClient as jest.Mock<any>).mockImplementation(() => ({getJson}));

    await getManifestFromURL();

    expect(getJson).toHaveBeenCalledWith(
      'https://mirror.example/py/versions-manifest.json'
    );
  });
});

describe('installCpythonFromRelease auth gating', () => {
  const makeRelease = (downloadUrl: string) =>
    ({
      version: '3.12.0',
      stable: true,
      release_url: '',
      files: [
        {
          filename: 'python-3.12.0-linux-x64.tar.gz',
          platform: 'linux',
          platform_version: '',
          arch: 'x64',
          download_url: downloadUrl
        }
      ]
    }) as any;

  // Returns the auth argument tc.downloadTool was called with.
  async function downloadAuthFor(downloadUrl: string) {
    (tc.downloadTool as jest.Mock<any>).mockResolvedValue('/tmp/py.tgz');
    (tc.extractTar as jest.Mock<any>).mockResolvedValue('/tmp/extracted');

    await installCpythonFromRelease(makeRelease(downloadUrl));

    const call = (tc.downloadTool as jest.Mock<any>).mock.calls[0];
    expect(call[0]).toBe(downloadUrl);
    return call[2];
  }

  it('forwards token to github.com download URLs', async () => {
    setInputs({token: 'TKN'});
    await expect(
      downloadAuthFor(
        'https://github.com/actions/python-versions/releases/download/3.12.0-x/python-3.12.0-linux-x64.tar.gz'
      )
    ).resolves.toBe('token TKN');
  });

  it('forwards token to api.github.com download URLs', async () => {
    setInputs({token: 'TKN'});
    await expect(
      downloadAuthFor('https://api.github.com/repos/x/y/tarball/main')
    ).resolves.toBe('token TKN');
  });

  it('forwards token to *.githubusercontent.com download URLs', async () => {
    setInputs({token: 'TKN'});
    await expect(
      downloadAuthFor('https://objects.githubusercontent.com/x/python.tar.gz')
    ).resolves.toBe('token TKN');
  });

  it('does NOT forward token to a non-GitHub download URL', async () => {
    setInputs({token: 'TKN', mirror: 'https://cdn.example'});
    await expect(
      downloadAuthFor('https://cdn.example/py.tar.gz')
    ).resolves.toBeUndefined();
  });

  it('does NOT forward token to a lookalike host', async () => {
    setInputs({token: 'TKN', mirror: 'https://evil-github.com'});
    await expect(
      downloadAuthFor('https://evil-github.com/py.tar.gz')
    ).resolves.toBeUndefined();
  });

  it('forwards mirror-token to a non-GitHub download URL', async () => {
    setInputs({
      token: 'TKN',
      'mirror-token': 'MTOK',
      mirror: 'https://cdn.example'
    });
    await expect(
      downloadAuthFor('https://cdn.example/py.tar.gz')
    ).resolves.toBe('token MTOK');
  });

  it('prefers mirror-token over token for GitHub download URLs', async () => {
    setInputs({token: 'TKN', 'mirror-token': 'MTOK'});
    await expect(
      downloadAuthFor('https://github.com/o/r/releases/download/v/py.tar.gz')
    ).resolves.toBe('token MTOK');
  });

  it('sends no auth when no tokens are configured', async () => {
    await expect(
      downloadAuthFor('https://github.com/o/r/releases/download/v/py.tar.gz')
    ).resolves.toBeUndefined();
  });
});
