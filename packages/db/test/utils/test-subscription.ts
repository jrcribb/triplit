import { CollectionQuery, DB, FetchResult, TripleRow } from '../../src';

interface Step<Q extends CollectionQuery<any, any>> {
  action: (results: FetchResult<Q>) => Promise<void> | void;
  check: (results: FetchResult<Q>) => Promise<void> | void;
  noopTimeout?: number;
}

interface TriplesStep {
  action: (results: TripleRow[]) => Promise<void> | void;
  check: (results: TripleRow[]) => Promise<void> | void;
  noopTimeout?: number;
}

type Steps<Q extends CollectionQuery<any, any>> = [
  Pick<Step<Q>, 'check'>,
  ...Step<Q>[]
];

export async function testSubscription<Q extends CollectionQuery<any, any>>(
  db: DB,
  query: Q,
  steps: Steps<Q>
) {
  return new Promise<void>((resolve, reject) => {
    let stepIndex = 0;
    let awaitingNoop = false;
    db.subscribe(
      query,
      async (results) => {
        try {
          if (awaitingNoop) return reject(new Error('Noop timeout failed'));
          await steps[stepIndex].check(results);
          stepIndex++;
          if (stepIndex >= steps.length) {
            return resolve();
          }
          await steps[stepIndex].action(results);
          if (steps[stepIndex].noopTimeout) {
            const currentStepIdx = stepIndex;
            setTimeout(async () => {
              awaitingNoop = true;
              if (currentStepIdx === stepIndex) {
                await steps[stepIndex].check(results);
                awaitingNoop = false;
                stepIndex++;
                if (stepIndex >= steps.length) {
                  return resolve();
                }
              } else {
                throw new Error('Step has been changed');
              }
            }, steps[stepIndex].noopTimeout);
          }
        } catch (e) {
          reject(e);
        }
      },
      (error) => reject(error)
    );
  });
}

export async function testSubscriptionTriples<
  Q extends CollectionQuery<any, any>
>(db: DB, query: Q, steps: TriplesStep[]) {
  return new Promise<void>((resolve, reject) => {
    let stepIndex = 0;
    let awaitingNoop = false;
    db.subscribeTriples(
      query,
      async (results) => {
        try {
          if (awaitingNoop) return reject(new Error('Noop timeout failed'));
          await steps[stepIndex].check(results);
          stepIndex++;
          if (stepIndex >= steps.length) {
            return resolve();
          }
          await steps[stepIndex].action(results);
          if (steps[stepIndex].noopTimeout) {
            awaitingNoop = true;
            const currentStepIdx = stepIndex;
            setTimeout(async () => {
              if (currentStepIdx === stepIndex) {
                await steps[stepIndex].check(results);
                awaitingNoop = false;
                stepIndex++;
                if (stepIndex >= steps.length) {
                  return resolve();
                }
              } else {
                reject(new Error('Step has been changed'));
              }
            }, steps[stepIndex].noopTimeout);
          }
        } catch (e) {
          reject(e);
        }
      },
      (error) => reject(error)
    );
  });
}
