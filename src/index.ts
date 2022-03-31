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
import {relatavize_path} from "@jcroall/synopsys-sig-node/lib/paths";
import {gitlabCreateDiscussionWithoutPosition} from "@jcroall/synopsys-sig-node/lib/gitlab/discussions";
import {PolarisTaskInputs} from "@jcroall/synopsys-sig-node/lib/polaris/model/PolarisTaskInput";
import PolarisConnection from "@jcroall/synopsys-sig-node/lib/polaris/model/PolarisConnection";
import PolarisInputReader from "@jcroall/synopsys-sig-node/lib/polaris/input/PolarisInputReader";
import PolarisService from "@jcroall/synopsys-sig-node/lib/polaris/service/PolarisService";
import {gitlabGetChangesForMR} from "@jcroall/synopsys-sig-node/lib/gitlab/gitlab-changes";
import ChangeSetEnvironment from "@jcroall/synopsys-sig-node/lib/polaris/changeset/ChangeSetEnvironment";
import ChangeSetFileWriter from "@jcroall/synopsys-sig-node/lib/polaris/changeset/ChangeSetFileWriter";
import ChangeSetReplacement from "@jcroall/synopsys-sig-node/lib/polaris/changeset/ChangeSetReplacement";
import PolarisInstaller from "@jcroall/synopsys-sig-node/lib/polaris/cli/PolarisInstaller";
import PolarisInstall from "@jcroall/synopsys-sig-node/lib/polaris/model/PolarisInstall";
import PolarisRunner from "@jcroall/synopsys-sig-node/lib/polaris/cli/PolarisRunner";
import * as os from "os";
import PolarisIssueWaiter from "@jcroall/synopsys-sig-node/lib/polaris/util/PolarisIssueWaiter";

const chalk = require('chalk')
const figlet = require('figlet')
const program = require('commander')

const GITLAB_SECURITY_DASHBOARD_SAST_FILE = "synopsys-gitlab-sast.json"

export async function main(): Promise<void> {
  console.log(
      chalk.blue(
          figlet.textSync('polaris-gitlab', { horizontalLayout: 'full' })
      )
  )
  program
      .description("Integrate Synopsys Polaris Static Analysis into GitLab")
      .option('-u, --polaris-url <Polaris URL>', 'Location of the Polaris service')
      .option('-a, --polaris-args <Polaris arguments>', 'Arguments to pass to polaris CLI')
      .option('-b, --build-command <Build Command>', 'Command for building the project from source code')
      .option('-d, --debug', 'Enable debug mode (extra verbosity)')
      .parse(process.argv)

  const options = program.opts()

  logger.info(`Starting Coverity GitLab Integration`)

  const POLARIS_ACCESS_TOKEN = process.env['POLARIS_ACCESS_TOKEN']
  const POLARIS_URL = process.env['POLARIS_URL']

  const POLARIS_PROXY_URL = process.env['POLARIS_PROXY_URL']
  const POLARIS_PROXY_USERNAME = process.env['POLARIS_PROXY_USERNAME']
  const POLARIS_PROXY_PASSWORD = process.env['POLARIS_PROXY_PASSWORD']

  logger.info(`url=${options.polarisUrl}`)
  let polaris_url = options.polarisUrl ? options.polarisUrl as string : POLARIS_URL
  if (!polaris_url) {
    logger.error(`Must specify Polaris URL in arguments or environment`)
    process.exit(1)
  }

  if (!POLARIS_ACCESS_TOKEN) {
    logger.error(`Mist specify Polaris Access Token in POLARIS_ACCESS_TOKEN`)
    process.exit(1)
  }

  if (!process.argv.slice(2).length) {
    program.outputHelp()
  }

  if (options.debug) {
    logger.level = 'debug'
    logger.debug(`Enabled debug mode`)
  }

  let build_command = options.buildCommand ? options.buildCommand : ""
  let polaris_args = options.polarisArgs ? options.polarisArgs : ""

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

  logger.info(`Connecting to Polaris service at: ${polaris_url}`)

  const task_input: PolarisTaskInputs = new PolarisInputReader().getPolarisInputs(polaris_url, POLARIS_ACCESS_TOKEN,
      POLARIS_PROXY_URL ? POLARIS_PROXY_URL : "",
      POLARIS_PROXY_USERNAME ? POLARIS_PROXY_USERNAME : "",
      POLARIS_PROXY_PASSWORD ? POLARIS_PROXY_PASSWORD : "",
      options.buildCommand, true, true, false)
  const connection: PolarisConnection = task_input.polaris_connection;

  var polaris_install_path: string | undefined;
  //polaris_install_path = `${process.env['HOME']}/.polaris-cli`
  polaris_install_path = os.tmpdir()
  if (!polaris_install_path) {
    logger.warn("Agent did not have a tool directory, polaris will be installed to the current working directory.");
    polaris_install_path = process.cwd();
  }
  logger.info(`Polaris Software Integrity Platform will be installed to the following path: ` + polaris_install_path);

  logger.info("Connecting to Polaris Software Integrity Platform server.")
  const polaris_service = new PolarisService(logger, connection);
  await polaris_service.authenticate();
  logger.debug("Authenticated with polaris.");

  try {
    logger.debug("Fetching organization name and task version.");
    const org_name = await polaris_service.fetch_organization_name();
    logger.debug(`Organization name: ${org_name}`)
    /*
    const task_version = PhoneHomeService.FindTaskVersion();

    logger.debug("Starting phone home.");
    const phone_home_service = PhoneHomeService.CreateClient(log);
    await phone_home_service.phone_home(connection.url, task_version, org_name);
    logger.debug("Phoned home.");
     */
  } catch (e){
    /*
    logger.debug("Unable to phone home.");
     */
  }

  const merge_request_iid = parseInt(CI_MERGE_REQUEST_IID, 10)


  //If there are no changes, we can potentially bail early, so we do that first.
  var actual_build_command = build_command;
  if (merge_request_iid > 0 && task_input.should_populate_changeset) {
    logger.debug("Populating change set for Polaris Software Integrity Platform.");
    const changed_files = await gitlabGetChangesForMR(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid)
    if (changed_files.length == 0 && task_input.should_empty_changeset_fail) {
      logger.error(` Task failed: No changed files were found.`)
      return;
    } else if (changed_files.length == 0) {
      logger.info("Task finished: No changed files were found.")
      return;
    }
    const change_set_environment = new ChangeSetEnvironment(logger, process.env);
    const change_file = change_set_environment.get_or_create_file_path(process.cwd());
    change_set_environment.set_enable_incremental();

    await new ChangeSetFileWriter(logger).write_change_set_file(change_file, changed_files);
    actual_build_command = new ChangeSetReplacement().replace_build_command(actual_build_command, change_file);

    logger.debug(`actual_build_command=${actual_build_command} change_file=${change_file}`)
  }

  logger.info("Installing Polaris Software Integrity Platform.");
  var polaris_installer = PolarisInstaller.default_installer(logger, polaris_service);
  var polaris_install: PolarisInstall = await polaris_installer.install_or_locate_polaris(connection.url, polaris_install_path);
  logger.info("Found Polaris Software Integrity Platform: " + polaris_install.polaris_executable);

  logger.info("Running Polaris Software Integrity Platform.");
  var polaris_runner = new PolarisRunner(logger);
  var polaris_run_result = await polaris_runner.execute_cli(connection, polaris_install, process.cwd(), actual_build_command);

  if (task_input.should_wait_for_issues) {
    logger.info("Checking for issues.")
    var polaris_waiter = new PolarisIssueWaiter(logger);
    var issue_count = await polaris_waiter.wait_for_issues(polaris_run_result.scan_cli_json_path, polaris_service);
    if (issue_count != null && issue_count > 0) {
      logger.error(`Polaris Software Integrity Platform found ${issue_count} total issues.`)
    }
  } else {
    logger.info("Will not check for issues.")
  }

  logger.info("Task completed.")

  logger.info("Executed Polaris Software Integrity Platform: " + polaris_run_result.return_code);

  /*
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

   */
}

/*
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
 */

main()