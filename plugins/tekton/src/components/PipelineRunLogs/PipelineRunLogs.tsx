import React from 'react';

import { LogViewer, Progress } from '@backstage/core-components';

import { V1Pod } from '@kubernetes/client-node';
import { Paper } from '@material-ui/core';
import Grid from '@material-ui/core/Grid';

import {
  getTaskRunsForPipelineRun,
  pipelineRunFilterReducer,
  PipelineRunKind,
  TaskRunKind,
} from '@janus-idp/shared-react';

import { getActiveTaskRun, getSortedTaskRuns } from '../../utils/taskRun-utils';
import { PipelineRunLogViewer } from './PipelineRunLogViewer';
import { TaskStatusStepper } from './TaskStatusStepper';

type PipelineRunLogsProps = {
  pipelineRun: PipelineRunKind;
  taskRuns: TaskRunKind[];
  pods: V1Pod[];
  activeTask?: string;
};
export const PipelineRunLogs = ({
  pipelineRun,
  taskRuns,
  pods,
  activeTask,
}: PipelineRunLogsProps) => {
  const PLRTaskRuns = getTaskRunsForPipelineRun(pipelineRun, taskRuns);
  const sortedTaskRuns = getSortedTaskRuns(PLRTaskRuns);
  const taskRunFromYaml = PLRTaskRuns?.reduce(
    (acc: { [value: string]: TaskRunKind }, value) => {
      if (value?.metadata?.name) {
        acc[value.metadata.name] = value;
      }
      return acc;
    },
    {},
  );

  const completed = pipelineRunFilterReducer(pipelineRun);
  const [userSelectedStepId, setUserSelectedStepId] = React.useState<string>(
    activeTask ?? '',
  );
  const [lastActiveStepId, setLastActiveStepId] = React.useState<string>('');

  React.useEffect(() => {
    const mostRecentFailedOrActiveStep = sortedTaskRuns.find(tr =>
      ['Failed', 'Running'].includes(tr.status),
    );

    if (completed && !mostRecentFailedOrActiveStep && !activeTask) {
      setLastActiveStepId(sortedTaskRuns[sortedTaskRuns.length - 1]?.id);
      return;
    }

    setLastActiveStepId(
      !activeTask ? (mostRecentFailedOrActiveStep?.id as string) : '',
    );
  }, [sortedTaskRuns, completed, activeTask]);

  const currentStepId = userSelectedStepId || lastActiveStepId;
  const activeItem = getActiveTaskRun(sortedTaskRuns, currentStepId);
  const podName =
    activeItem && taskRunFromYaml?.[currentStepId]?.status?.podName;
  const podData = React.useMemo(
    () =>
      pods.find(pod => {
        return pod?.metadata?.name === podName;
      }),
    [pods, podName],
  );

  return (
    <Grid container>
      <Grid item xs={3}>
        <Paper>
          <TaskStatusStepper
            steps={sortedTaskRuns}
            currentStepId={currentStepId}
            onUserStepChange={setUserSelectedStepId}
          />
        </Paper>
      </Grid>
      <Grid item xs={9}>
        {!currentStepId && <Progress />}
        <div style={{ height: '80vh' }}>
          {!podData ? (
            <Paper
              elevation={1}
              style={{ height: '100%', width: '100%', minHeight: '30rem' }}
            >
              <LogViewer text="No Logs found" />
            </Paper>
          ) : (
            <PipelineRunLogViewer pod={podData as V1Pod} />
          )}
        </div>
      </Grid>
    </Grid>
  );
};

export default PipelineRunLogs;
