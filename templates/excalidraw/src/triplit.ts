import { TriplitClient } from '@triplit/client';
import { useQuery } from '@triplit/react';
import { usePageId } from './use-query-params.js';
import { useMemo } from 'react';

export const client = new TriplitClient({
  serverUrl: import.meta.env.VITE_TRIPLIT_SERVER_URL,
  token: import.meta.env.VITE_TRIPLIT_TOKEN,
});

export function usePages() {
  return useQuery(client, client.query('pages').order(['createdAt', 'DESC']));
}
export function useExcalidrawElements() {
  const [currentPageId] = usePageId();
  return useQuery(
    client,
    client.query('elements').where('pageId', '=', currentPageId)
  );
}

export function useUnsyncedElements() {
  const [currentPageId] = usePageId();
  return useQuery(
    client,
    client
      .query('elements')
      .where('pageId', '=', currentPageId)
      .syncStatus('pending')
  );
}

export function useUnsyncedElementsCount() {
  const { results: allUnsyncedElements } = useUnsyncedElements();
  return useMemo(() => {
    if (!allUnsyncedElements) return {};
    return [...allUnsyncedElements.values()].reduce((acc, elem) => {
      acc[elem.pageId] ? (acc[elem.pageId] += 1) : (acc[elem.pageId] = 1);
      return acc;
    }, {});
  }, [allUnsyncedElements]);
}

export async function createNewPage() {
  const pageId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return client.insert('pages', {
    name: 'Untitled page',
    id: pageId,
    createdAt: new Date().toISOString(),
  });
}
