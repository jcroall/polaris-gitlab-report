#!/usr/bin/env node

import {
  gitlabCreateDiscussion,
  gitlabGetDiffMap,
  gitlabGetDiscussions,
  gitlabGetProject,
  gitlabUpdateNote,
  CoverityIssuesView,
  CoverityProjectIssue,
  coverityMapMatchingMergeKeys,
  coverityCreateReviewCommentMessage,
  coverityCreateIssueCommentMessage,
  COVERITY_COMMENT_PREFACE,
  coverityIsInDiff,
  coverityIsPresent,
  coverityCreateNoLongerPresentMessage, CoverityIssueOccurrence
} from "@jcroall/synopsys-sig-node/lib/"

import {logger} from "@jcroall/synopsys-sig-node/lib";
import * as fs from "fs";
import {relatavize_path} from "@jcroall/synopsys-sig-node/lib/path";
import {gitlabCreateDiscussionWithoutPosition} from "@jcroall/synopsys-sig-node/lib/gitlab/discussions";

const chalk = require('chalk')
const figlet = require('figlet')
const program = require('commander')

const GITLAB_SECURITY_DASHBOARD_SAST_FILE = "synopsys-gitlab-sast.json"

export async function main(): Promise<void> {
  console.log(
      chalk.blue(
          figlet.textSync('coverity-gitlab', { horizontalLayout: 'full' })
      )
  )
  program
      .description("Integrate Synopsys Coverity Static Analysis into GitLab")
      .option('-j, --json <Coverity Results v7 JSON>', 'Location of the Coverity Results v7 JSON')
      .option('-u, --coverity-url <Coverity URL>', 'Location of the Coverity server')
      .option('-p, --coverity-project <Coverity Project Name>', 'Name of Coverity project')
      .option('-g, --gitlab-security', 'Generate GitLab Security Dashboard output')
      .option('-d, --debug', 'Enable debug mode (extra verbosity)')
      .parse(process.argv)

  const options = program.opts()

  logger.info(`Starting Coverity GitLab Integration`)

  const COVERITY_URL = process.env['COVERITY_URL']
  const COVERITY_PROJECT = process.env['COVERITY_PROJECT']
  const COV_USER = process.env['COV_USER']
  const COVERITY_PASSPHRASE = process.env['COVERITY_PASSPHRASE']

  let coverity_url = options.coverityUrl ? options.coverityUrl as string : COVERITY_URL
  if (!coverity_url) {
    logger.error(`Must specify Coverity URL in arguments or environment`)
    process.exit(1)
  }

  let coverity_project_name = options.coverityProject ? options.coverityProject as string : COVERITY_PROJECT
  if (!coverity_project_name) {
    logger.error(`Must specify Coverity Project in arguments or environment`)
    process.exit(1)
  }

  const coverity_results_file: string = undefined === options.json
      ? 'coverity-results.json'
      : options.json || 'coverity-results.json'

  logger.info(`Using JSON file path: ${coverity_results_file}`)

  if (!process.argv.slice(2).length) {
    program.outputHelp()
  }

  if (options.debug) {
    logger.level = 'debug'
    logger.debug(`Enabled debug mode`)
  }

  const GITLAB_TOKEN = process.env['GITLAB_TOKEN']
  const CI_SERVER_URL = process.env['CI_SERVER_URL']
  const CI_MERGE_REQUEST_IID = process.env['CI_MERGE_REQUEST_IID']! // MR Only
  const CI_MERGE_REQUEST_DIFF_BASE_SHA = process.env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] // MR Only
  const CI_COMMIT_SHA = process.env['CI_COMMIT_SHA']
  const CI_PROJECT_NAMESPACE = process.env['CI_PROJECT_NAMESPACE']
  const CI_PROJECT_NAME = process.env['CI_PROJECT_NAME']
  const CI_PROJECT_ID = process.env['CI_PROJECT_ID']
  const CI_COMMIT_BRANCH = process.env['CI_COMMIT_BRANCH'] // Push only

  if (!GITLAB_TOKEN || !CI_SERVER_URL || !CI_PROJECT_NAMESPACE || !CI_PROJECT_NAME || !CI_PROJECT_ID || !CI_COMMIT_SHA) {
    logger.error(`Must specify GITLAB_TOKEN, CI_SERVER_URL, CI_PROJECT_NAMESPACE, CI_PROJECT_ID, CI_COMMIT_SHA and CI_PROJECT_NAME.`)
    process.exit(1)
  }

  let is_merge_request = !!CI_MERGE_REQUEST_IID

  if (!is_merge_request) {
    if (!CI_COMMIT_BRANCH) {
      logger.error(`Must specify CI_COMMIT_BRANCH.`)
      process.exit(1)
    }
  } else {
    if (!CI_MERGE_REQUEST_DIFF_BASE_SHA) {
      logger.error(`Must specify CI_MERGE_REQUEST_DIFF_BASE_SHA when running from merge request.`)
      process.exit(1)
    }
  }

  // Collect all Coverity data and generate optional GitLab Security dashboard before interacting with GitLab

  // TODO validate file exists and is .json?
  const jsonV7Content = fs.readFileSync(coverity_results_file)
  const coverityIssues = JSON.parse(jsonV7Content.toString()) as CoverityIssuesView

  let mergeKeyToIssue = new Map<string, CoverityProjectIssue>()

  const canCheckCoverity = coverity_url && COV_USER && COVERITY_PASSPHRASE && coverity_project_name
  if (!canCheckCoverity) {
    logger.warn('Missing Coverity Connect info. Issues will not be checked against the server.')
  } else {
    const allMergeKeys = coverityIssues.issues.map(issue => issue.mergeKey)
    const allUniqueMergeKeys = new Set<string>(allMergeKeys)

    if (canCheckCoverity && coverityIssues && coverityIssues.issues.length > 0) {
      try {
        mergeKeyToIssue = await coverityMapMatchingMergeKeys(coverity_url, COV_USER, COVERITY_PASSPHRASE,
            coverity_project_name, allUniqueMergeKeys)
      } catch (error: any) {
        logger.error(error as string | Error)
        process.exit(1)
      }
    }
  }

  if (options.gitlabSecurity) {
    logger.info(`Generating GitLab Security Dashboard output: ${GITLAB_SECURITY_DASHBOARD_SAST_FILE}`)
    let gitlab_json = gitlab_initialize_coverity_json()
    for (const issue of coverityIssues.issues) {
      const projectIssue = mergeKeyToIssue.get(issue.mergeKey)
      let cid_url = undefined
      if (projectIssue) {
        cid_url = `${COVERITY_URL}/query/defects.htm?project=${COVERITY_PROJECT}&cid=${projectIssue.cid}`
      } else {
        cid_url = ''
      }

      gitlab_json.vulnerabilities.push(gitlab_get_coverity_json_vulnerability(issue, cid_url))
    }

    fs.writeFileSync(GITLAB_SECURITY_DASHBOARD_SAST_FILE, JSON.stringify(gitlab_json, null, 2), 'utf8')
  }

  if (!is_merge_request) {
    logger.info('Not a Pull Request, nothing else to do.')
    return
  }

  const merge_request_iid = parseInt(CI_MERGE_REQUEST_IID, 10)

  logger.info(`Connecting to GitLab: ${CI_SERVER_URL}`)

  let project = await gitlabGetProject(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID)
  logger.debug(`Project=${project.name}`)



  const review_discussions = await gitlabGetDiscussions(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid).
    then(discussions => discussions.filter(discussion => discussion.notes![0].body.includes(COVERITY_COMMENT_PREFACE)))
  const diff_map = await gitlabGetDiffMap(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid)

  for (const issue of coverityIssues.issues) {
    logger.info(`Found Coverity Issue ${issue.mergeKey} at ${issue.strippedMainEventFilePathname}:${issue.mainEventLineNumber}`)

    const projectIssue = mergeKeyToIssue.get(issue.mergeKey)
    let ignoredOnServer = false
    let newOnServer = true
    if (projectIssue) {
      ignoredOnServer = projectIssue.action == 'Ignore' || projectIssue.classification in ['False Positive', 'Intentional']
      newOnServer = projectIssue.firstSnapshotId == projectIssue.lastSnapshotId
      logger.info(`Issue state on server: ignored=${ignoredOnServer}, new=${newOnServer}`)
    }

    const reviewCommentBody = coverityCreateReviewCommentMessage(issue)

    let path = issue.strippedMainEventFilePathname.startsWith('/') ?
        relatavize_path(process.cwd(), issue.strippedMainEventFilePathname) :
        issue.strippedMainEventFilePathname

    let file_link = `${CI_SERVER_URL}/${process.env.CI_PROJECT_NAMESPACE}/${process.env.CI_PROJECT_NAME}/-/blob/${process.env.CI_COMMIT_REF_NAME}/${path}#L${issue.mainEventLineNumber}`
    const issueCommentBody = coverityCreateIssueCommentMessage(issue, file_link)

    const review_discussion_index = review_discussions.findIndex(
        discussion => discussion.notes![0].position?.new_line === issue.mainEventLineNumber &&
            discussion.notes![0].body.includes(issue.mergeKey))
    let existing_discussion = undefined
    if (review_discussion_index !== -1) {
      existing_discussion = review_discussions.splice(review_discussion_index, 1)[0]
    }

    const comment_index = review_discussions.findIndex(discussion => discussion.notes![0].body.includes(issue.mergeKey))
    let existing_comment = undefined
    if (comment_index !== -1) {
      existing_comment = review_discussions.splice(comment_index, 1)[0]
    }

    if (existing_discussion !== undefined) {
      logger.info(`Issue already reported in discussion #${existing_discussion.id} note #${existing_discussion.notes![0].id}, updating if necessary...`)
      if (existing_discussion.notes![0].body !== reviewCommentBody) {
        await gitlabUpdateNote(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid,
            parseInt(existing_discussion.id, 10),
            existing_discussion.notes![0].id,
            reviewCommentBody).catch(error => {
              logger.error(`Unable to update discussion: ${error.message}`)
        })

      }
    } else if (existing_comment !== undefined) {
      logger.info(`Issue already reported in discussion #${existing_comment.id} note #${existing_comment.notes![0].id}, updating if necessary...`)
      if (existing_comment.notes![0].body !== issueCommentBody) {
        await gitlabUpdateNote(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid,
            parseInt(existing_comment.id, 10),
            existing_comment.notes![0].id,
            reviewCommentBody).catch(error => {
              logger.error(`Unable to update discussion: ${error.message}`)
        })
      }
    } else if (ignoredOnServer) {
      logger.info('Issue ignored on server, no comment needed.')
    } else if (!newOnServer) {
      logger.info('Issue already existed on server, no comment needed.')
    } else if (coverityIsInDiff(issue, diff_map)) {
      logger.info('Issue not reported, adding a comment to the review.')

      await gitlabCreateDiscussion(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid, issue.mainEventLineNumber,
          issue.strippedMainEventFilePathname, reviewCommentBody, CI_MERGE_REQUEST_DIFF_BASE_SHA ? CI_MERGE_REQUEST_DIFF_BASE_SHA : '',
          CI_COMMIT_SHA ? CI_COMMIT_SHA : '').catch(error => {
            logger.error(`Unable to create discussion: ${error.message}`)
      })
    } else {
      logger.info('Issue not reported, adding an issue comment.')

      await gitlabCreateDiscussionWithoutPosition(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid, issueCommentBody).catch(error => {
            logger.error(`Unable to create discussion: ${error.message}`)
      })
    }
  }

  for (const discussion of review_discussions) {
    if (coverityIsPresent(discussion.notes![0].body)) {
      logger.info(`Discussion #${discussion.id} Note #${discussion.notes![0].id} represents a Coverity issue which is no longer present, updating comment to reflect resolution.`)
      await gitlabUpdateNote(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid,
          parseInt(discussion.id, 10),
          discussion.notes![0].id, coverityCreateNoLongerPresentMessage(discussion.notes![0].body)).catch(error => {
            logger.error(`Unable to update note #${discussion.notes![0].id}: ${error.message}`)
      })
    }
  }

  logger.info(`Found ${coverityIssues.issues.length} Coverity issues.`)

  if (coverityIssues.issues.length > 0) {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

function gitlab_get_coverity_json_vulnerability(issue: CoverityIssueOccurrence, cid_url: string) : any {
  let json_vlun = {
    id: issue.mergeKey,
    cve: issue.mergeKey,
    category: "sast",
    name: issue.checkerProperties?.subcategoryShortDescription,
    message: issue.checkerProperties?.subcategoryShortDescription,
    description: issue.checkerProperties?.subcategoryLongDescription,
    severity: issue.checkerProperties?.impact,
    confidence: "High",
    scanner: {
      id: "synopsys_coverity",
      name: "Synopsys Coverity"
    },
    location: {
      file: issue.strippedMainEventFilePathname,
      start_line: issue.mainEventLineNumber,
      end_line: issue.mainEventLineNumber,
      class: issue.functionDisplayName ? issue.functionDisplayName : "",
      method: issue.functionDisplayName ? issue.functionDisplayName : ""
    },
    identifiers: [
      {
        type: "synopsys_coverity_type",
        name: `Coverity ${issue.checkerName}`,
        value: issue.checkerName,
        url: (cid_url && cid_url.length > 0) ? cid_url : "http://url-not-available-for-this-issue"
      }
    ]
  }

  if (cid_url && cid_url.length > 0) {
    json_vlun.identifiers[0].url = cid_url
  }

  if (issue.checkerProperties?.cweCategory && issue.checkerProperties.cweCategory != "none") {
    let cwe_identifer = {
      type: "cwe",
      name: `CWE-${issue.checkerProperties.cweCategory}`,
      value: issue.checkerProperties.cweCategory,
      url: `https://cwe.mitre.org/data/definitions/${issue.checkerProperties.cweCategory}.html`
    }
    json_vlun.identifiers.push(cwe_identifer)
  }

  return(json_vlun)
}


function gitlab_initialize_coverity_json() : any {
  return {
    version: '2.0',
    vulnerabilities: []
  };
}

main()