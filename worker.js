import cluster from 'node:cluster'
import Core    from '@superhero/core'

// If the worker is a core cluster worker start the core and 
// listen for control messages from the primary process.
if(cluster.isWorker
&& process.env.CORE_CLUSTER_WORKER)
{
  const core = new Core()
  process.on('message', core.onEvent.bind(core))
  process.send('ready')
}