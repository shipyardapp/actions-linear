import process from 'process';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import {
	LinearClient,
	LinearFetch,
	Issue,
	Organization,
	User,
} from '@linear/sdk';
import * as core from '@actions/core';
import * as github from '@actions/github';

// Set so there is a Promise compatible constructor for TypeScript to latch onto.
// So we can use LinearFetch<T> in async return types.
const LinearFetch = Promise;

function newLinearClient(): LinearClient {
	const params: any = {};
	const apiKey = process.env.LINEAR_API_KEY;
	if (!!apiKey) {
		params.apiKey = apiKey;
	}
	return new LinearClient(params);
}

async function getCurrentUser(lc: LinearClient): LinearFetch<User> {
	return lc.viewer;
}

async function getCurrentOrganization(lc: LinearClient): LinearFetch<Organization> {
	return lc.organization;
}

async function onCreateBranch(lc: LinearClient, branchName: string): Promise<Issue> {
	const org = await getCurrentOrganization(lc);

	const { assignee, issueIdentifier } = collectAssigneeIssueIdentifierFromBranchName(
		org,
		branchName,
	);

	let issue = await maybeUpdateIssueToTeamDraftState(lc, issueIdentifier);
	issue = await maybeSetIssueAssignee(lc, issue, assignee);
	return issue;
}

async function maybeUpdateIssueToTeamDraftState(lc: LinearClient, issueIdentifier: string): Promise<Issue> {
	const issue = await lc.issue(issueIdentifier);
	const issueState = await issue.state;
	const team = await issue.team;
	if (!team) {
		throw new Error('Issue does not belong to a Team');
	}
	const teamDraftState = await team.draftWorkflowState;
	if (!teamDraftState || !issueState) {
		throw new Error('Team does not have draft state OR issue does not have state');
	}
	if (['triage', 'backlog', 'unstarted'].includes(issueState.type)) {
		console.log(`Setting Issue to '${teamDraftState.name}' ...`);
		await issue.update({ stateId: teamDraftState.id });
		console.log(`Successfully set Issue ${issueIdentifier} to '${teamDraftState.name}'.`);
	} else {
		console.log(`Issue is already '${teamDraftState.name}' or further along.`);
	}
	return issue;
}

async function maybeSetIssueAssignee(lc: LinearClient, issue: Issue, assigneeName: string|null): Promise<Issue> {
	if (!assigneeName) {
		return issue;
	}
	const assignee = await issue.assignee;
	if (!assignee) {
		const user = await getUserFromDisplayName(lc, assigneeName);
		if (!user) {
			throw new Error('Unable to get User information to assign');
		}

		console.log(`Assigning Issue to ${assigneeName} ...`);
		await issue.update({
			assigneeId: user.id,
		});
		console.log(`Successfully assigned issue to ${assigneeName}.`);
	} else {
		console.log('Issue is already assigned. Not overwriting.');
	}
	return issue;
}

async function getUserFromDisplayName(lc: LinearClient, displayName: string): Promise<User|null> {
	const users = await lc.users({
		filter: {
			displayName: { eq: displayName },
		},
	});
	if (users.nodes.length !== 1) {
		return null;
	}
	return users.nodes[0];
}

function collectAssigneeIssueIdentifierFromBranchName(
	org: Organization,
	branch: string,
): { assignee: string|null, issueIdentifier: string } {
	const { gitBranchFormat } = org;

	let assignee: string|null = null;
	let issueIdentifier: string|null = null;

	if (gitBranchFormat === '{username}/{issueIdentifier}-{issueTitle}') {
		const slashParts = branch.split('/');
		console.log('slashParts', slashParts);
		if (slashParts.length !== 2) {
			throw new Error('IncompatibleBranchFormat');
		}
		assignee = slashParts[0];

		const idTitleParts = slashParts[1].split('-');
		console.log('idTitleParts', idTitleParts);
		if (idTitleParts.length < 2) {
			throw new Error('IncompatibleBranchFormat');
		}
		issueIdentifier = `${idTitleParts[0].toUpperCase()}-${idTitleParts[1]}`;
	} else {
		throw new Error('IncompatibleBranchFormat');
	}

	if (issueIdentifier === null) {
		throw new Error('IncompatibleBranchFormat');
	}

	return { assignee, issueIdentifier };
}

async function main(args: Arguments): Promise<void> {
	if (args._.length !== 1) {
		process.exit(1);
		return;
	}

	const lc = newLinearClient();
	const org = await getCurrentOrganization(lc);

	const command = args._[0];
	if (command === 'on-create-branch') {
		onCreateBranch(lc, args.branchName as string);
	}
}

interface Arguments {
	_: string[];
	branchName?: string;
}

let argv = [...process.argv];
console.log('hello from linear-utils.ts', 'initial args', argv);
if (github.context.job) {
	argv.push(
		core.getInput('command'),
		core.getInput('on_create_branch'),
	);
}
console.log('real args', argv);

const args = yargs(hideBin(argv))
	.command('on-create-branch <branch>', 'Set Linear Issue Assignee and Status for a branch', yargs => {
		return yargs.positional(
			'branch',
			{
				describe: 'The new PR branch name to use to update a Linear Issue',
				type: 'string',
				alias: 'branchName',
			},
		);
	})
	.strictCommands(true)
	.demandCommand(1, 'Provide a command')
	.help()
	.argv;

main(args as Arguments);

