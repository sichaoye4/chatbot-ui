import { createRoot } from 'react-dom/client';
import { MaterializedResponse } from '../../packages/contracts/protocol.ts';
import { ResponseRenderer } from '../../packages/renderer-openui/foundation.tsx';
import { builtinRegistry } from '../../packages/renderer-openui/builtins.tsx';
import '../../packages/renderer-openui/foundation.css';

declare global {
  interface Window {
    foundationChartFixtures: unknown[];
  }
}
const responses = window.foundationChartFixtures.map((item) => MaterializedResponse.parse(item));
createRoot(document.getElementById('root')!).render(
  <>
    <h1>Synthetic v2 chart gallery</h1>
    {responses.map((response) => (
      <ResponseRenderer key={response.responseId} response={response} registry={builtinRegistry} />
    ))}
  </>,
);
