import { publishWorker } from './publish-worker.mjs'

publishWorker('build:unity-bundle', 'core/engines/unity/bundle/worker/AssetViewer.UnityBundle.csproj', 'unity-bundle')
