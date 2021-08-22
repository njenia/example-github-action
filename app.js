const os = require('os')
const spawn = require('await-spawn');
const path = require('path');
const fetch = require('node-fetch')
const execa = require('execa')
const process = require('process')
const {execSync} = require('child_process')
const fs = require('fs')
const crypto = require("crypto");

const toIngestData = ({
                        assetId, assetUri, branch, assetName, ref
                      }, {
                        items,
                        run_context,
                        stats: {
                          total_files_read,
                          total_bytes_read,
                          duration: {nanos}
                        }
                      }, changesDir) => {
  return {
    asset: {
      id: `git://github.com/${assetName}`,
      uri: assetUri,
      ref,
      name: assetName,
      variant: branch,
      source: 'github.com',
      kind: 'git',
    },
    time: new Date().toISOString(),
    issues: items.map((item) => {
      const relativePath = item.finding.substring(item.finding.indexOf(changesDir) + changesDir.length)
      return {
        relativePath,
        absolutePath: `${assetUri}${relativePath}`,
        position: item.position,
        line_start: item.position.start[0],
        fingerprint: item.fingerprint,
        rule: {
          id: item.rule_id,
          name: item.rule_desc,
          severity: item.severity,
          description: item.rule_desc,
        },
        metadata: {
          isGithubAppProbotScan: true
        },
      }
    }),
    stats: {
      totalFilesRead: total_files_read,
      totalBytesRead: total_bytes_read,
      durationMillis: Math.floor(nanos / 1000000),
    },
    metadata: {
      scanner: {name: 'spectral', version: '1.5.8'},
      scanContext: run_context,
    }
  }
}

module.exports = (app) => {
  app.log.info("Yay, the app was loaded!");
  app.on(
    [
      'pull_request.opened',
      'pull_request.reopened',
      'pull_request.edited',
      'pull_request.synchronize',],
    async (context) => {
      const { octokit, payload: {pull_request: pullRequest, repository} } = context;
      const {base, head, number} = pullRequest;

      const { html_url: assetUri, full_name: fullRepoName } = repository
      const [owner, repo] = fullRepoName.split('/')
      const {data: {id: checkId}} = await octokit.rest.checks.create({
        owner,
        repo,
        head_sha: pullRequest.head.sha,
        base_sha: pullRequest.base.sha,
        name: 'Spectral scan',
        status: 'in_progress'
      })

      const compare = await octokit.rest.repos.compareCommits(context.repo({
        base: pullRequest.base.sha,
        head: pullRequest.head.sha
      }));

      const {files} = compare.data;
      const changes = await Promise.all(files
        .filter(({ status }) => status !== 'removed')
        .map(async (file) => {
          const {data: {content}} = await octokit.repos.getContent({
            owner,
            repo,
            path: file.filename,
            ref: head.sha
          })

          const decodedContent = Buffer.from(content, 'base64')

          return {
            filename: file.filename,
            lineMap: file.patch,
            content: decodedContent.toString(),
          }
        })
      )

      const id = crypto.randomBytes(16).toString("hex")
      const changesDir = path.join(os.tmpdir(), id)
      fs.mkdirSync(changesDir)
      for (const change of changes) {
        const { filename, content } = change

        const changeDirPath = filename.substring(0, filename.lastIndexOf('/') + 1)
        fs.mkdirSync(path.join(changesDir, changeDirPath), { recursive: true })
        fs.writeFileSync(path.join(changesDir, filename), content)
      }

      process.chdir(changesDir)
      const spectralOutputFile = path.join(__dirname, 'out.json')
      execSync(`${path.join(__dirname, 'spectral')} scan --json-v2 ${spectralOutputFile} --ok --nosend`)

      const results = JSON.parse(fs.readFileSync(spectralOutputFile, 'utf8'))

      const adaptedIngestData = toIngestData({
        assetId: repo, assetUri, branch: head.ref, assetName: fullRepoName, ref: head.sha
      }, results, changesDir)
      const spectralSaasHost = process.env.SPECTRAL_DSN.split('@')[1]
      let spectralIngestUrl = `http://${spectralSaasHost}/api/v1/ingest?dsn=${process.env.SPECTRAL_DSN}`;
      const res = await fetch(spectralIngestUrl, {
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify(adaptedIngestData)
      })
      if (res.status === 200) {
        const resBody = await res.json()
        const issues = resBody.assetChanges.issuesOnlyInThisVariant
        const issuesCount = issues.length
        console.info(`found ${issuesCount} issues`)
        await octokit.rest.checks.update({
          owner,
          repo,
          check_run_id: checkId,
          status: 'completed',
          conclusion: issuesCount === 0 ? 'success' : 'failure',
          output: {
            title: 'Spectral',
            summary: "<img src='https://spectralops.io/wp-content/themes/tg/assets/images/sections/footer/logo.svg' width='200'/>\n" + `There ${issuesCount === 1 ? 'is' : 'are'} ${issuesCount} issue${issuesCount === 1 ? '' : 's'} found in this PR changes.`,
            text: issuesCount === 0 ? '' : `PR: [${pullRequest.title}](${pullRequest.html_url})` + "\n" +
              "Here are the issues we found in your PR:\n" +
              "|Detector|File Path||\n" +
              "|---|---|---|\n" +
              issues.map(({detectorName, uri, path}) => `|${detectorName}|${path}|[view code](${uri})|`).join('\n') + "\n\n" +
              "[See scan](https://" + spectralSaasHost + "/scans/" + resBody.scanPid + ") in SpectralOps." + "\n" +
              "Spectral is a developer-first security tool to identify and monitor secrets in your code and cloud."
          }
        })
      } else {
        const resBody = await res.json()
        console.error(`ingest request failed with code ${res.status}. Result: ${JSON.stringify(resBody)}`)
      }

      // fs.unlinkSync(changesDir)
    }
  )
}
