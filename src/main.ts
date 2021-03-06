import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { CHECK_NAME, EXTENSIONS_TO_LINT } from './constants';
import { eslint } from './eslint-cli';
import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import fs from 'fs';
import { chunk } from 'lodash';

/**
 * This is just for syntax highlighting, does nothing
 * @param {string} s
 */
const gql = (s: TemplateStringsArray): string => s.join('');

async function run() {
  const octokit = new Octokit({
    auth: core.getInput('repo-token', { required: true }),
  });
  const context = github.context;

  const graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${core.getInput('repo-token', { required: true })}`,
    },
  });

  const prInfo = await graphqlWithAuth(
    gql`
      query($owner: String!, $name: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $prNumber) {
            files(first: 100) {
              nodes {
                path
              }
            }
            commits(last: 1) {
              nodes {
                commit {
                  oid
                }
              }
            }
          }
        }
      }
    `,
    {
      owner: context.repo.owner,
      name: context.repo.repo,
      prNumber: context.issue.number,
    },
  );
  if (prInfo === null) {
    core.setFailed('Could not get PR info!');
    return;
  }
  const currentSha = prInfo.repository.pullRequest.commits.nodes[0].commit.oid;
  // console.log('Commit from GraphQL:', currentSha);
  const files = prInfo.repository.pullRequest.files.nodes;

  const filesToLint = files
    .filter(f => fs.existsSync(f.path))
    .filter(f => EXTENSIONS_TO_LINT.has(path.extname(f.path)))
    .map(f => f.path);
  if (filesToLint.length < 1) {
    console.warn(
      `No files with [${[...EXTENSIONS_TO_LINT].join(
        ', ',
      )}] extensions added or modified in this PR, nothing to lint...`,
    );
    return;
  }

  let checkId;
  const givenCheckName = core.getInput('check-name');
  if (givenCheckName) {
    const checks = await octokit.checks.listForRef({
      ...context.repo,
      status: 'in_progress',
      ref: currentSha,
    });
    const theCheck = checks.data.check_runs.find(({ name }) => name === givenCheckName);
    if (theCheck) checkId = theCheck.id;
  }
  if (!checkId) {
    checkId = (
      await octokit.checks.create({
        ...context.repo,
        name: CHECK_NAME,
        head_sha: currentSha,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      })
    ).data.id;
  }

  try {
    const { conclusion, output } = await eslint(filesToLint);
    const { annotations } = output;

    // Split into chunks of 50
    for (const annotationsChunk of chunk(annotations, 50)) {
      await octokit.checks.update({
        ...context.repo,
        check_run_id: checkId,
        completed_at: new Date().toISOString(),
        conclusion,
        output: Object.assign(output, { annotations: annotationsChunk }),
      });
    }

    if (conclusion === 'failure') {
      core.setFailed(`ESLint found some errors`);
    }
  } catch (error) {
    await octokit.checks.update({
      ...context.repo,
      check_run_id: checkId,
      conclusion: 'failure',
      completed_at: new Date().toISOString(),
    });
    core.setFailed(JSON.stringify(error));
  }
}

run();
