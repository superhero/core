import os           from 'node:os'
import cluster      from 'node:cluster'
import EventEmitter from 'node:events'
import path         from 'node:path'
import url          from 'node:url'
import util         from 'node:util'
import bootstrap    from '@superhero/bootstrap'
import Locate       from '@superhero/locator'
import Log          from '@superhero/log'

export default class Core
{
  locate = new Locate

  get config()
  {
    return this.locate.config
  }

  set config(_)
  {
    const error = new Error('Can not set the config (read-only) property')
    error.code  = 'E_CORE_CONFIG_SET'
    error.cause = 'Alter the config instance through the bundled locator'
    throw error
  }

  /**
   * @param {string} branch The branch to use to add branch specific configurations.
   */
  constructor(branch)
  {
    this.branch   = branch
    this.basePath = this.locate.pathResolver.basePath // synchronize the base path.
    Core.#setupDestroyer(this)
  }

  #branch
  #workers  = {}
  #basePath = false
  #isForked = false
  #isBooted = false
  #eventlog = new Proxy([],
  {
    get: (target, prop, receiver) =>
    {
      // when pushing events to the eventlog, also sync the event to all workers
      if('push' === prop) return (...events) => 
      {
        setImmediate(() => 
        {
          for(const id in this.#workers) 
          {
            this.#workers[id]?.sync()
          }
        })
        return target.push(...events)
      }
      // Default behavior for other properties
      return Reflect.get(target, prop, receiver)
    }
  })

  // An exposed log instance taht the core instance uses that is open for modification.
  static log = new Log({ label: process.env.CORE_CLUSTER_WORKER ? `[CORE:${process.env.CORE_CLUSTER_WORKER}]` : '[CORE]' })

  // Used for graceful termination, if multiple cores are instanciated.
  static #cores = new Map

  // Used to prevent multiple observers on the process events.
  static #destroyerIsSetup = false

  // Used to prevent multiple destroy calls.
  static #destroyerIsTriggered = false

  static #setupDestroyer(core)
  {
    Core.#cores.set(core, core)

    if(false === Core.#destroyerIsSetup)
    {
      Core.#destroyerIsSetup = true

      process.on('SIGINT',  (signal) => Core.#destroy(signal))
      process.on('SIGTERM', (signal) => Core.#destroy(signal))

      process.on('unhandledRejection', (reason) => Core.#destroy(false, reason))
      process.on('uncaughtException',  (error)  => Core.#destroy(false, error))
    }
  }

  /**
   * Attempts to destroy all core instances gracefully.
   */
  static async #destroy(signal, reason)
  {
    if(Core.#destroyerIsTriggered)
    {
      Core.log.info`redundant shutdown signal ${signal} waiting for previous shutdown process to finalize…`
      reason && Core.log.fail`${reason}`
      return
    }

    Core.#destroyerIsTriggered = true

    signal
    ? Core.log.warn`graceful shutdown initiated ${signal}`
    : Core.log.warn`graceful shutdown initiated`

    const
      destroyedCores = [],
      destroyRejects = []

    for(const core of Core.#cores.values())
    {
      destroyedCores.push((async () => 
      {
        try
        {
          await core.destroy()
        }
        catch(error)
        {
          destroyRejects.push(error)
        }
      })())
    }

    await Promise.all(destroyedCores)

    if(destroyRejects.length)
    {
      const error = new Error('Failed to shutdown gracefully')
      error.code  = 'E_CORE_DESTROY_GRACEFUL'
      error.cause = destroyRejects
      Core.log.fail`${error}`
      reason && Core.log.fail`${reason}`
      setImmediate(() => process.exit(1))
    }
    else if(reason)
    {
      Core.log.fail`${reason}`
      setImmediate(() => process.exit(1))
    }
    else
    {
      setImmediate(() => process.exit(0))
    }
  }

  async destroy()
  {
    // First remove the core instance from the static core registry 
    // to prevent multiple destroy calls.
    Core.#cores.delete(this)

    // Then destroy the core workers, if clustered, using a timeout.
    const
      timeout          = this.config.find('core/destroy/timeout', 15e3),
      timeoutError     = new Error(`Failed to destroy core within ${(timeout/1e3).toFixed(1)}s`),
      destroyTimeout   = (ctx) => new Promise((_, reject) => ctx.id = setTimeout(() => reject(timeoutError), timeout)),
      destroyedWorkers = [],
      destroyRejects   = []

    timeoutError.code = 'E_CORE_DESTROY_TIMEOUT'

    for(const id in this.#workers)
    {
      destroyedWorkers.push((async () => 
      {
        // Attempt to kill the worker.
        this.#workers[id].kill()
        // Wait for the worker to exit.
        while(this.#workers[id]?.process?.connected) await new Promise(setImmediate)
      })())
    }

    try
    {
      if(destroyedWorkers.length)
      {
        const timeout = {}
        await Promise.race([ destroyTimeout(timeout), Promise.all(destroyedWorkers) ])
        clearTimeout(timeout.id)
      }
    }
    catch(reason)
    {
      const error = new Error(`Failed to destroy workers`)
      error.code  = 'E_CORE_DESTROY_WORKERS'
      error.cause = reason
      destroyRejects.push(error)
    }

    // Then destroy the core locator and all loaded services, restricted by a 
    // timeout if it takes to long.
    try
    {
      const timeout = {}
      await Promise.race([ destroyTimeout(timeout), this.locate.destroy() ])
      clearTimeout(timeout.id)
    }
    catch(reason)
    {
      const error = new Error(`Failed to destroy locator`)
      error.code  = 'E_CORE_DESTROY_LOCATOR'
      error.cause = reason
      destroyRejects.push(error)
    }

    if(destroyRejects.length)
    {
      const error = new Error(`Failed to destroy core gracefully`)
      error.code  = 'E_CORE_DESTROY'
      error.cause = destroyRejects
      throw error
    }
  }

  /**
   * The base path used to resolve relative file paths.
   * @type {string|undefined}
   */
  set basePath(basePath)
  {
    this.#basePath = basePath

    // Forward the base path for the scoped path-resolver
    // used by the locator and config services.
    // OBS! this logic relies on that the locator and config 
    // services uses the same path-resolver.
    this.locate.pathResolver.basePath = basePath

    this.#eventlog.push({ type: 'basePath', basePath })
  }

  get basePath()
  {
    return this.#basePath
  }

  /**
   * The branch to use to add branch specific configurations.
   * @type {string|undefined}
   */
  set branch(branch)
  {
    this.#branch = branch
    this.#eventlog.push({ type: 'branch', branch })
  }

  get branch()
  {
    return this.#branch
  }

  /**
   * Public access to the workers, if the core is clustered.
   */
  get workers()
  {
    return this.#workers
  }

  /**
   * Add configurations to the core context.
   */
  async add(configPaths)
  {
    const normalizedConfigPaths = this.#normalizeConfigPaths(configPaths)

    for(const configPath of normalizedConfigPaths)
    {
      await this.#addConfigPath(configPath)
    }

    this.#eventlog.push({ type: 'add', configPaths })

    return this
  }

  /**
   * Bootstrap the core instance, or the core cluster workers - if the core is clustered.
   * @param {object} [options]          - Options to pass to the bootstrap process.
   * @param {boolean} [options.freeze]  - If true, then freezes the config.
   */
  async bootstrap(options)
  {
    Object.assign(Log.config, this.config.find('log'))

    if(this.#isForked)
    {
      // If the core is forked, then forward the bootstrap event to all workers
      // instead of applying the bootstrap process in the primary core instance.
      this.#eventlog.push({ type: 'bootstrap', options })
    }
    else if(false === this.#isBooted)
    {
      options?.freeze && this.config.freeze()

      util.inspect.defaultOptions = this.config.find('util/inspect', util.inspect.defaultOptions)

      const locatorMap = this.config.find('locator')
      locatorMap && await this.locate.eagerload(locatorMap)
  
      const bootstrapMap = this.config.find('bootstrap')
      bootstrapMap && await bootstrap(bootstrapMap, this.config, this.locate)

      this.#isBooted = true
    }
    else
    {
      const error = new Error('Can not bootstrap the core multiple times')
      error.code  = 'E_CORE_BOOTSTRAP_MULTIPLE_TIMES'
      throw error
    }
  
    return this
  }

  /**
   * Cluster the core instance into 1 or multiple workers.
   * 
   * @param {number} [forks]   The number of workers to fork, defaults to the number of CPU cores.
   * @param {number} [branch]  The branch of the first worker, defaults to 1.
   * @param {number} [version] The version of the first worker, defaults to 1.
   */
  async cluster(forks, branch = 1, version = 1)
  {
    if(undefined === forks)
    {
      forks = os.cpus().length
    }

    this.#validateClustering(forks, branch, version)

    this.#isForked = true

    // Set the worker execution script.
    const
      pwd                   = path.dirname(url.fileURLToPath(import.meta.url)),
      primaryClusterConfig  = this.config.find('core/cluster/primary', { exec: path.join(pwd, 'worker.js') })

    cluster.setupPrimary(primaryClusterConfig)

    for(let i = 0; i < forks; i++)
    {
      const
        forkBranch  = branch + i,
        forkVersion = version,
        limitLength = String(this.config.find('core/cluster/restart/limit', 99)).length,
        forkId      = `${forkBranch.toString(36).toUpperCase()}.${String(forkVersion).padStart(limitLength, '0')}`

      this.#workers[forkId] = await this.#fork(forkId)
      this.#workers[forkId].once('exit', this.#reloadWorker.bind(this, forkId, forkBranch, forkVersion))
      this.#workers[forkId].sync = this.#createSynchoronizer(forkId)

      Core.log.info`${'CORE:' + forkId} ⇡ clustered`

      try
      {
        await this.#workers[forkId].sync()
      }
      catch(reason)
      {
        const error = new Error(`Failed to synchronize worker ${forkId}`)
        error.code  = 'E_CORE_CLUSTER_SYNC'
        error.cause = reason
        throw error
      }

      Core.log.info`synchronized ${'CORE:' + forkId}`
    }

    return branch + forks
  }

  #createSynchoronizer(id)
  {
    const 
      emitter   = new EventEmitter(),
      refection = this.#workers[id].send.bind(this.#workers[id]),
      send      = (event) => new Promise((accept, reject) =>
      {
        emitter.once('synced',  accept)
        emitter.once('exit',    reject)

        id in this.#workers
        ? refection(event)
        : reject(new Error(`Worker ${id} does not exist`))
      })

    this.#workers[id].send          = false // disable the send method from anywhere else
    this.#workers[id].synchronizing = false
    this.#workers[id].eventlogIndex = 0
    this.#workers[id].on('message', (msg) => 'string' === typeof msg && emitter.emit(msg))

    return async () =>
    {
      // prevent multiple simultanious sync calls.
      if(this.#workers[id].synchronizing)
      {
        return
      }

      // disable the sync method while running.
      this.#workers[id].synchronizing = true

      // If the worker has restarted, or the core already has added resources,
      // then forward the eventlog of the primary core instance to the 
      // worker to initiate the worker to a synchronized state.
      while(this.#workers[id].eventlogIndex < this.#eventlog.length)
      {
        await send(this.#eventlog[ this.#workers[id].eventlogIndex++ ])
      }
      
      this.#workers[id].synchronizing = false
    }
  }

  /**
   * Is expected to be used when the core is clustered, then this method checks
   * if the core workers are synchronized by checking if the "sent" property of
   * all the workers are balanced to 0.
   * 
   * @returns {boolean}
   */
  isClusterSynched()
  {
    for(const id in this.#workers)
    {
      if(this.#workers[id].sent)
      {
        return false
      }
    }

    return true
  }

  /**
   * Is expected to be used when the core is clustered, then this method called 
   * when a control message is received from the primary process.
   * 
   * @param {object} event The message object sent from the primary process.
   */
  async onEvent(event)
  {
    switch(event.type)
    {
      case 'add':
      {
        await this.add(event.configPaths)
        break
      }
      case 'basePath':
      {
        this.basePath = event.basePath
        break
      }
      case 'bootstrap':
      {
        await this.bootstrap(event.freeze)
        break
      }
      case 'branch':
      {
        this.branch = event.branch
        break
      }
      default:
      {
        const error = new Error(`Unknown message type ${event.type}`)
        error.code  = 'E_CORE_WORKER_UNKNOWN_MESSAGE_TYPE'
        throw error
      }
    }

    process.send('synced')
  }

  #fork(id)
  {
    return new Promise((accept, reject) =>
    {
      const
        worker  = cluster.fork({ CORE_CLUSTER_WORKER: id }),
        onError = (error)   => (worker.off('message', onReady), reject(error)),
        onReady = (message) => 
        {
          if('ready' === message)
          {
            worker.off('error',   onError)
            worker.off('message', onReady)

            accept(worker)
          }
        }

      worker.once('error', onError)
      worker.on('message', onReady)
    })
  }

  async #reloadWorker(id, branch, version, code, signal)
  {
    const 
      failedToSynchronize = this.#workers[id].synchronizing,
      signal_code         = signal ? `${signal}:${code}` : code,
      label               = `CORE:${id}`

    this.#workers[id].removeAllListeners()
    this.#workers[id].kill()
    delete this.#workers[id]

    if(0 === code)
    {
      Core.log.warn`${label} ⇣ terminated`
    }
    else if('SIGTERM'  === signal
         || 'SIGINT'   === signal
         || 'SIGQUIT'  === signal)
    {
      Core.log.warn`${label} ⇣ terminated ⇠ ${signal_code}`
    }
    else if(version >= this.config.find('core/cluster/restart/limit', 99))
    {
      const error = new Error(`${label} has reached the restart limit`)
      error.code  = 'E_CORE_CLUSTER_RESTART_LIMIT'
      error.cause = `${label} process crashed ${signal_code}`
      throw error
    }
    else if(failedToSynchronize)
    {
      const error = new Error(`${label} failed to synchronize`)
      error.code  = 'E_CORE_CLUSTER_SYNC_FAILED'
      throw error
    }
    else
    {
      try
      {
        Core.log.warn`restarting ${label} ⇡ previous process crashed ⇠ ${signal_code}`
        await this.cluster(1, branch, version + 1)
      }
      catch(reason)
      {
        const error = new Error(`Could not fork worker ${id}`)
        error.code  = 'E_CORE_CLUSTER_FORK_ERROR'
        error.cause = reason
        throw error
      }
    }
  }

  async #addConfigPath(configPath)
  {
    const { filepath, config } = await this.config.resolve(configPath)
    await this.#addConfigDependencies(filepath, config)
    this.config.add(filepath, config)
    Core.log.info`assigned config ${configPath}`

    if(this.branch)
    {
      try
      {
        const { filepath, config } = await this.config.resolve(configPath, this.branch)
        await this.#addConfigDependencies(filepath, config)
        this.config.add(filepath, config)
        Core.log.info`assigned config ${configPath + '-' + this.branch}`
      }
      catch(error)
      {
        if(error.code !== 'E_CONFIG_RESOLVE')
        {
          throw error
        }
      }
    }
  }

  async #addConfigDependencies(parentFilepath, parentConfig)
  {
    const dependencies = parentConfig.dependency

    if(false === !!dependencies)
    {
      return
    }

    const dependenciesType = Object.prototype.toString.call(dependencies)
                
    if('[object Object]' !== dependenciesType)
    {
      const error = new TypeError(`Invalid configured dependency type: ${dependenciesType}`)
      error.code  = 'E_CORE_INVALID_DEPENDENCY_TYPE'
      throw error
    }

    for(const id in dependencies)
    {
      let dependencyPath = dependencies[id]

      if(false === dependencyPath)
      {
        continue
      }

      if(true === dependencyPath)
      {
        dependencyPath = id
      }

      if('string' !== typeof dependencyPath)
      {
        const error = new TypeError(`Invalid dependency path type: ${Object.prototype.toString.call(dependencyPath)}`)
        error.code  = 'E_CORE_INVALID_DEPENDENCY_PATH_TYPE'
        error.cause = 'The values of configured dependency attribute must be of type string'
        throw error
      }

      if(dependencyPath.startsWith('.'))
      {
        dependencyPath = path.normalize(path.join(parentFilepath, dependencyPath))
      }

      const { filepath, config } = await this.config.resolve(dependencyPath)
      await this.#addConfigDependencies(filepath, config)
      this.config.add(filepath, config)
      Core.log.info`assigned config ${dependencyPath}`
    }
  }

  #normalizeConfigPaths(configPaths)
  {
    const configPathsType = Object.prototype.toString.call(configPaths)

    switch(configPathsType)
    {
      case '[object Array]':
      {
        return configPaths
      }
      case '[object Object]':
      {
        return Object.keys(configPaths).filter((key) => configPaths[key])
      }
      case '[object String]':
      {
        return [configPaths]
      }
      default:
      {
        const error = new TypeError(`Invalid config paths type: ${configPathsType}`)
        error.code  = 'E_CORE_INVALID_CONFIG_PATHS_TYPE'
        error.cause = 'Config paths must be type; one of: array, object or string'
        throw error
      }
    }
  }

  #validateClustering(forks, branch, version)
  {
    if(process.env.CORE_CLUSTER_WORKER)
    {
      const error = new Error('Can not cluster the core from a worker process')
      error.code  = 'E_CORE_CLUSTER_FROM_WORKER'
      throw error
    }

    if(this.#isBooted)
    {
      const error = new Error('Can not cluster the core after it has been bootstrapped')
      error.code  = 'E_CORE_CLUSTER_BOOTSTRAPPED'
      throw error
    }
    
    if('number' !== typeof forks)
    {
      const error = new TypeError('Forks argument must be a number')
      error.code  = 'E_CORE_CLUSTER_INVALID_FORKS_TYPE'
      error.cause = `Invalid forks type: ${Object.prototype.toString.call(forks)}`
      throw error
    }

    if('number' !== typeof branch)
    {
      const error = new TypeError('Cluster branch argument must be a number')
      error.code  = 'E_CORE_CLUSTER_INVALID_ID_TYPE'
      error.cause = `Invalid branch type: ${Object.prototype.toString.call(branch)}`
      throw error
    }

    if('number' !== typeof version)
    {
      const error = new TypeError('Cluster version argument must be a number')
      error.code  = 'E_CORE_CLUSTER_INVALID_VERSION_TYPE'
      error.cause = `Invalid version type: ${Object.prototype.toString.call(version)}`
      throw error
    }

    if(forks < 1)
    {
      const error = new RangeError(`Cluster forks argument (${forks}) is out of range`)
      error.code  = 'E_CORE_CLUSTER_FORKS_OUT_OF_RANGE'
      error.cause = 'Forks must be greater than 0'
      throw error
    }

    if(branch < 1)
    {
      const error = new RangeError(`Cluster branch argument (${branch}) is out of range`)
      error.code  = 'E_CORE_CLUSTER_ID_OUT_OF_RANGE'
      error.cause = 'Id must be greater than 0'
      throw error
    }

    if(version < 0)
    {
      const error = new RangeError(`Cluster version argument (${version}) is out of range`)
      error.code  = 'E_CORE_CLUSTER_VERSION_OUT_OF_RANGE'
      error.cause = 'Version can not be negative'
      throw error
    }
  }
}