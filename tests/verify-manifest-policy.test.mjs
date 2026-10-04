import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyManifestPolicy as verifyManifestPolicyAtRef } from '../scripts/verify-manifest-policy.mjs';
import { desiredFiles } from '../scripts/sync-plugin-standards.mjs';

const policyRef = 'a'.repeat(40);

function verifyManifestPolicy(inventory_, repository, root) {
  return verifyManifestPolicyAtRef(inventory_, repository, root, policyRef);
}

const manifest = {
  slug: 'example-plugin',
  main_file: 'example-plugin.php',
  risk: 'standard',
  minimum_php: '7.4',
  minimum_wordpress: '6.4',
  tested_wordpress: '7.1',
  wordpress_org: true,
  multisite: false,
  release_branch: 'master',
  php_matrix: ['7.4', '8.4'],
};
const inventory = { repositories: [{ repository: 'example/plugin', enabled: true, managed_paths: ['ci', 'release'], manifest }] };

function fixture(local = manifest) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-policy-'));
  mkdirSync(join(root, '.github'));
  mkdirSync(join(root, '.github/workflows'));
  writeFileSync(join(root, '.github/plugin-standard.json'), `${JSON.stringify({ $schema: 'https://example.test/schema.json', ...local }, null, 2)}\n`);
  writeFileSync(join(root, '.github/workflows/release.yml'), desiredFiles(root, inventory.repositories[0], policyRef).get('.github/workflows/release.yml'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('manifest policy accepts the exact centrally declared metadata', () => {
  const { root, cleanup } = fixture();
  try {
    assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
  } finally {
    cleanup();
  }
});

test('manifest policy rejects direct WordPress.org publishers outside the managed release caller', () => {
  for (const [name, workflow] of [
    ['deploy.yml', 'uses: 10UP/Action-WordPress-Plugin-Deploy@stable\n'],
    ['fork.yml', 'uses: example/action-wordpress-plugin-deploy@v2\n'],
    ['assets.yaml', 'uses: 10up/action-wordpress-plugin-asset-update@stable\n'],
    ['custom.yml', 'run: svn commit https://plugins.svn.wordpress.org/example-plugin\n'],
    ['options.yml', 'run: svn --non-interactive --username "$U" --password "$P" commit -m release\n'],
    ['continued.yml', 'run: |\n  svn --non-interactive \\\n    commit -m release\n'],
    ['folded.yml', 'run: >\n  svn --non-interactive\n  commit -m release\n'],
    ['aliases.yml', 'run: svn rm https://plugins.svn.wordpress.org/example-plugin/tags/1.0 -m cleanup\n'],
    ['git-svn.yml', 'run: git svn dcommit\n'],
    ['git-svn-tag.yml', 'run: git svn tag 1.0.0\n'],
    ['git-svn-path.yml', 'run: /usr/lib/git-core/git-svn branch release\n'],
    ['svnmucc.yml', 'run: svnmucc put artifact.zip https://plugins.svn.wordpress.org/example-plugin/trunk/artifact.zip\n'],
    ['list-step.yml', 'steps:\n  - run: svn commit -m release\n'],
    ['message-option.yml', 'run: svn -m release commit https://plugins.svn.wordpress.org/example-plugin\n'],
    ['file-option.yml', 'run: svn --file message.txt commit https://plugins.svn.wordpress.org/example-plugin\n'],
    ['path.yml', 'run: /usr/bin/svn commit -m release\n'],
    ['resolved-path.yml', 'run: "$(command -v svn)" ci -m release\n'],
    ['prop-alias.yml', 'run: svn ps stable_tag 1.0 https://plugins.svn.wordpress.org/example-plugin/trunk\n'],
    ['quoted.yml', "run: 'svn commit -m release'\n"],
    ['substitution.yml', 'run: result=$(svn commit -m release)\n'],
    ['backticks.yml', 'run: result=`svn commit -m release`\n'],
    ['shell.yml', "run: bash -c 'svn commit -m release'\n"],
    ['eval.yml', 'run: eval "svn commit -m release"\n'],
    ['escaped.yml', 'run: \\svn commit -m release\n'],
    ['split-name.yml', "run: 's'vn commit -m release\n"],
    ['variable.yml', 'run: $SVN commit -m release\n'],
    ['wrapped-variable.yml', 'run: env $WP_SVN commit -m release\n'],
    ['neutral-variable.yml', 'run: CMD=svn; "$CMD" commit -m release\n'],
    ['wrapped-neutral-variable.yml', 'run: env "$CMD" commit -m release\n'],
    ['wrapped-options-variable.yml', 'run: timeout 300 "$CMD" commit -m release\n'],
    ['wrapped-env-variable.yml', 'run: env FOO=1 "$CMD" commit -m release\n'],
    ['positional-variable.yml', 'run: set -- svn; "$1" commit -m release\n'],
    ['dynamic-executable.yml', 'run: "$(printf svn)" commit -m release\n'],
    ['unquoted-dynamic-executable.yml', 'run: $(printf svn) commit -m release\n'],
    ['backtick-dynamic-executable.yml', 'run: `printf svn` commit -m release\n'],
    ['composed-variable.yml', 'run: "$A$B" commit -m release\n'],
    ['dynamic-path.yml', 'run: "$DIR/$CMD" commit -m release\n'],
    ['nested-variable.yml', 'run: export CMD=svn; bash -c \'"$CMD" commit -m release\'\n'],
    ['wrapped-shell.yml', 'run: sudo bash -c \'svn commit -m release\'\n'],
    ['wrapped-shell-prefix.yml', 'run: sudo bash -c \'cd build && svn commit -m release\'\n'],
    ['shell-options.yml', 'run: bash -o pipefail -c \'svn commit -m release\'\n'],
    ['shell-positional.yml', 'run: bash -c \'"$@"\' _ svn commit -m release\n'],
    ['shell-zero-positional.yml', 'run: bash -c \'"$0" "$@"\' svn commit -m release\n'],
    ['dynamic-mucc-options.yml', 'run: "$CMD" -U https://plugins.svn.wordpress.org/example-plugin put artifact.zip trunk/artifact.zip -m release\n'],
    ['folded-blank-line.yml', 'run: >\n  true\n\n  svn commit -m release\n'],
    ['escaped-comment-space.yml', 'run: |\n  echo a\\ #b; svn commit -m release\n'],
    ['trap.yml', 'run: trap \'svn commit -m release\' EXIT\n'],
    ['coproc.yml', 'run: coproc svn commit -m release\n'],
    ['here-string.yml', 'run: bash <<< "svn commit -m release"\n'],
    ['piped-shell.yml', 'run: echo \'svn commit -m release\' | sh\n'],
    ['find-exec.yml', 'run: find . -maxdepth 0 -exec svn commit -m release {} +\n'],
    ['parallel.yml', 'run: parallel svn commit -m release ::: .\n'],
    ['parallel-template.yml', "run: parallel 'svn commit -m release {}' ::: .\n"],
    ['watch-template.yml', "run: watch -g 'svn commit -m release'\n"],
    ['python-shell.yml', "steps:\n  - shell: python\n    run: |\n      import os\n      os.system('svn commit -m release')\n"],
    ['encoding.yml', 'run: svn --encoding UTF-8 commit -m release\n'],
    ['inline.yml', 'steps:\n  - { name: Deploy, run: svn commit -m release }\n'],
    ['quoted-key.yml', 'steps:\n  - "run": svn commit -m release\n'],
    ['svnrdump.yml', 'run: svnrdump load https://plugins.svn.wordpress.org/example-plugin\n'],
    ['svnsync.yml', 'run: svnsync sync https://plugins.svn.wordpress.org/example-plugin\n'],
    ['quoted-comment.yml', 'run: "svn commit -m release" # publish\n'],
    ['quoted-flow.yml', 'steps:\n  - { name: Deploy, run: "svn commit -m release" }\n'],
    ['conditional.yml', 'run: if ! svn commit -m release; then exit 1; fi\n'],
    ['while.yml', 'run: while ! svn commit -m release; do sleep 5; done\n'],
    ['until.yml', 'run: until svn commit -m release; do sleep 5; done\n'],
    ['elif.yml', 'run: if false; then :; elif svn commit -m release; then :; fi\n'],
    ['case.yml', 'run: case "$X" in *) svn commit -m release ;; esac\n'],
    ['case-block.yml', 'run: |\n  case "$X" in\n    *) svn commit -m release ;;\n  esac\n'],
    ['case-second-branch.yml', 'run: case "$X" in a) :;; *) svn commit -m release;; esac\n'],
    ['stderr-redirect.yml', 'run: 2>/dev/null svn commit -m release\n'],
    ['stdout-redirect.yml', 'run: >/dev/null svn commit -m release\n'],
    ['spaced-stderr-redirect.yml', 'run: 2> /dev/null svn commit -m release\n'],
    ['spaced-stdout-redirect.yml', 'run: > /dev/null svn commit -m release\n'],
    ['duplicate-stderr.yml', 'run: 2>&1 svn commit -m release\n'],
    ['redirect-stderr.yml', 'run: >&2 svn commit -m release\n'],
    ['spaced-redirect-stderr.yml', 'run: >& /dev/null svn commit -m release\n'],
    ['then.yml', 'run: then svn commit -m release\n'],
    ['brace.yml', 'run: "{ svn commit -m release; }"\n'],
    ['exec.yml', 'run: exec svn commit -m release\n'],
    ['timeout.yml', 'run: timeout 300 svn commit -m release\n'],
    ['background.yml', 'run: echo ready & svn commit -m release\n'],
    ['git-options.yml', 'run: git -C build svn dcommit\n'],
    ['nested-substitution.yml', 'run: REV=$(svn commit -m "Release $(cat VERSION)")\n'],
    ['process-substitution.yml', 'run: cat <(svn commit -m release)\n'],
    ['indented-run.yml', 'steps:\n  - name: Publish\n    run: svn commit -m release\n'],
    ['indented-uses.yml', 'steps:\n  - name: Deploy\n    uses: 10up/action-wordpress-plugin-deploy@stable\n'],
    ['block-uses.yml', 'steps:\n  - name: Deploy\n    uses: >-\n      10up/action-wordpress-plugin-deploy@stable\n'],
    ['escaped-run.yml', 'run: "\\x73vn commit -m release"\n'],
    ['escaped-uses.yml', 'uses: "10up/action-wordpress-plugin-\\x64eploy@stable"\n'],
    ['quote-desync.yml', '# "\nenv:\n  P: "${{ secrets.WORDPRESS_ORG_\\x50ASSWORD }}"\n'],
    ['variable-subcommand.yml', 'run: svn "$OP" -m release\n'],
    ['targets.yml', 'run: svn rm --targets urls.txt -m release\n'],
    ['function.yml', 'run: publish() { svn "$@"; }; publish commit -m release\n'],
    ['xargs.yml', 'run: echo commit | xargs svn -m release\n'],
    ['tagged-run.yml', 'run: !!str "svn commit -m release"\n'],
    ['anchored-uses.yml', 'uses: &deploy 10up/action-wordpress-plugin-deploy@stable\n'],
    ['tagged-uses.yml', 'uses: !!str 10up/action-wordpress-plugin-deploy@stable\n'],
    ['aliased-uses.yml', 'uses: *deploy\n'],
    ['tab-escape.yml', 'run: "svn\\tcommit -m release"\n'],
    ['newline-escape.yml', 'run: "echo ok\\nsvn commit -m release"\n'],
    ['slash-escape.yml', 'uses: "10up\\/action-wordpress-plugin-deploy@stable"\n'],
    ['next-line-uses.yml', 'steps:\n  - uses:\n      10up/action-wordpress-plugin-deploy@stable\n'],
    ['which-path.yml', 'run: "$(which svn)" commit -m release\n'],
    ['type-path.yml', 'run: "$(type -P svn)" commit -m release\n'],
    ['commented-header.yml', 'steps:\n  - name: Build # note: |\n    run: "\\x73vn commit -m release"\n'],
    ['literal-indent.yml', 'run: |2\n    svn commit -m release\n'],
    ['folded-indent.yml', 'run: >2\n    svn commit -m release\n'],
    ['literal-indent-chomp.yml', 'run: |2-\n    svn commit -m release\n'],
    ['literal-chomp-indent.yml', 'run: |-2\n    svn commit -m release\n'],
    ['parameter-default.yml', 'run: ${SVN:-svn} commit -m release\n'],
    ['python.yml', 'run: python3 -c "import os; os.system(\'svn commit -m release\')"\n'],
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows', name), workflow);
      assert.throws(
        () => verifyManifestPolicy(inventory, 'example/plugin', root),
        /contains a direct WordPress\.org publisher/u,
        name,
      );
    } finally {
      cleanup();
    }
  }
});

test('manifest policy scans the managed release caller for appended publishers', () => {
  const { root, cleanup } = fixture();
  try {
    const path = join(root, '.github/workflows/release.yml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nuses: 10up/action-wordpress-plugin-deploy@stable\n`);
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /release\.yml differs from the fleet-managed release caller/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy ignores publisher action references in YAML comments', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/comment.yml'), '# replaced 10up/action-wordpress-plugin-deploy@stable\n');
    assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
  } finally {
    cleanup();
  }
});

test('manifest policy rejects WordPress.org credentials outside the managed caller', () => {
  for (const workflow of [
    'env:\n  SVN_USERNAME: ${{ secrets.SVN_USERNAME }}\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  PASSWORD: ${{ secrets.WORDPRESS_ORG_PASSWORD }}\nsteps:\n  - uses: example/wporg-deploy@v1\n',
    'jobs:\n  deploy:\n    uses: example/wporg.yml@v1\n    secrets: inherit\n',
    "env:\n  PASSWORD: ${{ secrets['WORDPRESS_ORG_PASSWORD'] }}\nsteps:\n  - run: ./bin/deploy.sh\n",
    'env:\n  ALL_SECRETS: ${{ toJSON(secrets) }}\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  PASSWORD: ${{ secrets.WPORG_PASS }}\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  PASSWORD: "${{ secrets.WORDPRESS_ORG_\\x50ASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    "env:\n  ALL_SECRETS: ${{ toJSON(secrets.*) }}\nsteps:\n  - run: ./bin/deploy.sh\n",
    "jobs:\n  deploy:\n    uses: example/wporg.yml@v1\n    secrets: 'inherit'\n",
    'jobs:\n  deploy:\n    uses: example/wporg.yml@v1\n    "secrets": inherit\n',
    'jobs:\n  deploy:\n    uses: example/wporg.yml@v1\n    secrets:\n      inherit\n',
    "env:\n  ALL_SECRETS: ${{ toJSON((secrets)) }}\nsteps:\n  - run: ./bin/deploy.sh\n",
    "env:\n  ALL_SECRETS: ${{ toJSON(secrets || '') }}\nsteps:\n  - run: ./bin/deploy.sh\n",
    'env:\n  P: |\n    #${{ secrets.WORDPRESS_ORG_PASSWORD }}\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  P: &password |\n    #${{ secrets.WORDPRESS_ORG_PASSWORD }}\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  P: !!str |\n    #${{ secrets.WORDPRESS_ORG_PASSWORD }}\nsteps:\n  - run: ./bin/deploy.sh\n',
    "env:\n  P: 'a'' #${{ secrets.WORDPRESS_ORG_PASSWORD }}'\nsteps:\n  - run: ./bin/deploy.sh\n",
    '# e.g. {key: "\nenv:\n  P: "deploy\n    # ${{ secrets.WORDPRESS_ORG_PASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    'jobs:\n  deploy: { uses: example/wporg.yml@v1, secrets: inherit }\n',
    'env:\n  P: &password "${{ secrets.WORDPRESS_ORG_\\x50ASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  P: !!str "${{ secrets.WORDPRESS_ORG_\\x50ASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  P: "deploy\n    ${{ secrets.WORDPRESS_ORG_\\x50ASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  P: "x: |\n    ${{ secrets.WORDPRESS_ORG_\\x50ASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  P: "deploy\n    # ${{ secrets.WORDPRESS_ORG_PASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    "env:\n  P: 'deploy\n    # ${{ secrets.WORDPRESS_ORG_PASSWORD }}'\nsteps:\n  - run: ./bin/deploy.sh\n",
    'env:\n  P:\n    "deploy\n    # ${{ secrets.WORDPRESS_ORG_PASSWORD }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env: { A: "a", P: "deploy\n  # ${{ secrets.WORDPRESS_ORG_PASSWORD }}" }\nsteps:\n  - run: ./bin/deploy.sh\n',
    'env:\n  P:\n    |\n      #${{ secrets.WORDPRESS_ORG_PASSWORD }}\nsteps:\n  - run: ./bin/deploy.sh\n',
    "env:\n  P: '${{ ''\n    #'' && secrets.WORDPRESS_ORG_PASSWORD }}'\nsteps:\n  - run: ./bin/deploy.sh\n",
    "env:\n  P: ${{ '}}' && secrets[format('WORDPRESS_ORG_{0}', 'PASSWORD')] }}\nsteps:\n  - run: ./bin/deploy.sh\n",
    'jobs:\n  with:\n    uses: ./.github/workflows/called.yml\n    secrets:\n      inherit\n',
    'jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n  with:\n    uses: example/deploy/.github/workflows/wporg.yml@v1\n    secrets: inherit\n',
    'jobs:\n  deploy: { uses: example/deploy/.github/workflows/wporg.yml@v1, secrets: &shared inherit }\n',
    'jobs:\n  with:\n    uses: ./.github/workflows/called.yml\n    secrets:\n      &shared inherit\n',
    'env:\n  P:\n    "${{ format(\'{0}{1}\', \'x\n    #\', secrets.WORDPRESS_ORG_PASSWORD) }}"\nsteps:\n  - run: ./bin/deploy.sh\n',
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows/custom.yml'), workflow);
      assert.throws(
        () => verifyManifestPolicy(inventory, 'example/plugin', root),
        /contains a direct WordPress\.org publisher/u,
        workflow,
      );
    } finally {
      cleanup();
    }
  }
});

test('manifest policy permits explicitly named unrelated secrets', () => {
  for (const workflow of [
    'jobs:\n  call:\n    uses: example/reusable/.github/workflows/ci.yml@v1\n    secrets:\n      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n',
    'jobs:\n  call:\n    uses: example/reusable/.github/workflows/ci.yml@v1\n    secrets: { OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}" }\n',
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows/reusable.yml'), workflow);
      assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
    } finally {
      cleanup();
    }
  }
});

test('manifest policy permits action inputs named secrets', () => {
  for (const workflow of [
    'steps:\n  - uses: docker/build-push-action@v6\n    with:\n      secrets: |\n        "github_token=${{ secrets.GITHUB_TOKEN }}"\n',
    'steps:\n  - uses: example/action@v1\n    with:\n      secrets: "id=npm,src=.npmrc"\n',
    'steps:\n  - with:\n      secrets: "id=npm,src=.npmrc"\n    uses: example/action@v1\n',
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows/action-input.yml'), workflow);
      assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
    } finally {
      cleanup();
    }
  }
});

test('manifest policy rejects central credential mappings outside the exact managed caller shape', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/release.yml'), 'jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    env:\n      STUTTTER_WORDPRESS_ORG_USERNAME: ${{ secrets.WORDPRESS_ORG_USERNAME }}\n      STUTTTER_WORDPRESS_ORG_PASSWORD: ${{ secrets.WORDPRESS_ORG_PASSWORD }}\n    steps:\n      - run: ./bin/deploy.sh\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /release\.yml differs from the fleet-managed release caller/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy scans local composite actions for direct publishers', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, '.github/actions/deploy'), { recursive: true });
    writeFileSync(join(root, '.github/actions/deploy/action.yml'), 'runs:\n  steps:\n    - uses: 10up/action-wordpress-plugin-deploy@stable\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy follows an indented local-action key', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, 'deploy'));
    writeFileSync(join(root, 'deploy/action.yml'), 'runs:\n  steps:\n    - run: svn commit -m release\n');
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - name: Deploy\n    uses: ./deploy\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /deploy\/action\.yml contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy follows local actions outside the conventional directory', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, 'deploy'), { recursive: true });
    writeFileSync(join(root, 'deploy/action.yml'), 'runs:\n  steps:\n    - uses: example/action-wordpress-plugin-asset-update@v1\n');
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./deploy\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /deploy\/action\.yml contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy follows a local action at the repository root', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, 'action.yml'), 'runs:\n  steps:\n    - run: svn commit -m release\n');
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /action\.yml contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy follows flow and quoted-key local actions', () => {
  for (const reference of ['steps:\n  - { uses: ./deploy }\n', 'steps:\n  - "uses": ./deploy\n']) {
    const { root, cleanup } = fixture();
    try {
      mkdirSync(join(root, 'deploy'));
      writeFileSync(join(root, 'deploy/action.yml'), 'runs:\n  steps:\n    - run: svn commit -m release\n');
      writeFileSync(join(root, '.github/workflows/local.yml'), reference);
      assert.throws(
        () => verifyManifestPolicy(inventory, 'example/plugin', root),
        /deploy\/action\.yml contains a direct WordPress\.org publisher/u,
      );
    } finally {
      cleanup();
    }
  }
});

test('manifest policy rejects local action paths that explicitly escape the repository', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./../outside\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /escapes the repository root/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects linked local action definitions', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, 'outside.yml'), 'runs:\n  steps:\n    - run: svn commit -m release\n');
    mkdirSync(join(root, 'deploy'));
    symlinkSync(join(root, 'outside.yml'), join(root, 'deploy/action.yml'));
    writeFileSync(join(root, '.github/workflows/local.yml'), 'steps:\n  - uses: ./deploy\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /deploy\/action\.yml must be a regular in-repository action definition/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects unresolved run aliases', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/alias.yml'), 'steps:\n  - run: *publish\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /Workflow run aliases are unsupported/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy inspects anchored run definitions', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/anchor.yml'), 'steps:\n  - run: &publish svn commit -m release\n');
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /contains a direct WordPress\.org publisher/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects non-regular workflow definitions', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, 'outside.yml'), 'uses: 10up/action-wordpress-plugin-deploy@stable\n');
    symlinkSync(join(root, 'outside.yml'), join(root, '.github/workflows/linked.yml'));
    assert.throws(
      () => verifyManifestPolicy(inventory, 'example/plugin', root),
      /linked\.yml must not be a symbolic link/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy permits non-YAML symlinked action assets', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, '.github/actions/build'), { recursive: true });
    writeFileSync(join(root, 'bin/build.sh'), '#!/bin/sh\n');
    writeFileSync(join(root, '.github/actions/build/action.yml'), 'runs:\n  using: composite\n  steps:\n    - run: ./entrypoint.sh\n      shell: bash\n');
    symlinkSync('../../../bin/build.sh', join(root, '.github/actions/build/entrypoint.sh'));
    assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
  } finally {
    cleanup();
  }
});

test('manifest policy leaves repository-owned workflows alone when release is not centrally managed', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, '.github/workflows/deploy.yml'), 'uses: 10up/action-wordpress-plugin-deploy@stable\n');
    const unmanaged = structuredClone(inventory);
    unmanaged.repositories[0].managed_paths = ['ci'];
    assert.doesNotThrow(() => verifyManifestPolicy(unmanaged, 'example/plugin', root));
  } finally {
    cleanup();
  }
});

test('manifest policy allows read-only Subversion inspection in managed repositories', () => {
  for (const workflow of [
    'run: svn --non-interactive info https://plugins.svn.wordpress.org/example-plugin\n',
    'run: svn export --quiet https://develop.svn.wordpress.org/tags/6.4/tests/phpunit/includes/ /tmp/wp-tests && rm -rf /tmp/wp-tests/.svn\n',
    'run: svn checkout https://plugins.svn.wordpress.org/example-plugin/trunk ci-cache\n',
    'run: |\n  command -v svn\n  rm -rf /tmp/wp-tests/.svn\n',
    'run: echo Skipping svn commit during the dry run\n',
    'run: svn info https://plugins.svn.wordpress.org/example-plugin # svn commit is intentionally disabled\n',
    'run: svn rm --force /tmp/wp-tests/.svn\n',
    'run: svn mkdir local-working-copy-directory\n',
    'run: svn rm --force "${RUNNER_TEMP}/wp-tests/.svn"\n',
    'run: svn --version\n',
    'run: which svn\n',
    'run: type svn\n',
    'run: git ls-files | grep -v svn\n',
    'run: case "$VCS" in svn) echo using-svn ;; esac\n',
    'run: case "$X" in a) echo svn ;; esac\n',
    'run: svn propget stable_tag https://plugins.svn.wordpress.org/example-plugin/trunk\n',
    'run: |\n  printf "version=%s\\n" "$VERSION" >> "$GITHUB_OUTPUT"\n  composer install --working-dir "plugin" \\\n    --no-interaction\n',
    'run: sudo rm -rf "$SVN_DIR"\n',
    'run: timeout 60 ls "$SVN_CACHE"\n',
    'run: |\n  echo "Deploying to: "\n  rsync -av \\\n    build/ dist/\n',
    'steps:\n  - run: echo "Building:" ${{ github.ref_name }}\n  - run: |\n      composer install \\\n        --no-interaction\n',
    'run: curl -sO https://plugins.svn.wordpress.org/example-plugin/trunk/readme.txt # CI\n',
    'run: "$PHP" -l example-plugin.php\n',
    'run: $COMPOSER install --no-interaction\n',
    'run: timeout "$SECONDS" "$PHP" -l example-plugin.php\n',
    'run: function inspect_url { svn info "$URL"; }\n',
    'run: function copy_file { cp "$SRC" "$DST"; }\n',
    'run: timeout "$SECONDS" echo commit\n',
    'run: sudo rm -rf svn\n',
    'run: nice rsync -a build/ svn/\n',
    'run: timeout 10 which svn\n',
    'run: command -V svn\n',
    'run: sudo -u svn whoami\n',
    'run: nice rsync -a svn/ build/\n',
  ]) {
    const { root, cleanup } = fixture();
    try {
      writeFileSync(join(root, '.github/workflows/audit.yml'), workflow);
      assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root), workflow);
    } finally {
      cleanup();
    }
  }
});

test('manifest policy ignores YAML comments', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, '.github/workflows/comment.yml'),
      '# SVN_PASSWORD and ${{ secrets.WORDPRESS_ORG_PASSWORD }} are available only to the central caller.\nname: Audit # ${{ secrets.WORDPRESS_ORG_PASSWORD }} remains central.\nenv:\n  TOKEN: ${{ secrets.GITHUB_TOKEN }} # ${{ secrets.WORDPRESS_ORG_PASSWORD }} remains central.\n',
    );
    assert.doesNotThrow(() => verifyManifestPolicy(inventory, 'example/plugin', root));
  } finally {
    cleanup();
  }
});

test('manifest policy binds the managed caller to the executing policy revision', () => {
  const { root, cleanup } = fixture();
  try {
    assert.throws(
      () => verifyManifestPolicyAtRef(inventory, 'example/plugin', root, 'b'.repeat(40)),
      /release\.yml differs from the fleet-managed release caller/u,
    );
  } finally {
    cleanup();
  }
});

test('manifest policy rejects stale local compatibility metadata', () => {
  const { root, cleanup } = fixture({ ...manifest, minimum_wordpress: '5.2' });
  try {
    assert.throws(() => verifyManifestPolicy(inventory, 'example/plugin', root), /differs from the immutable portfolio inventory/u);
  } finally {
    cleanup();
  }
});
