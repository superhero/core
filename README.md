
# Core

A framework designed to support application clustering, configuration management, and service location.

### OBS!

_Current version is in beta release_

---

## Features

- **Cluster Support**: Scale horizontally using the `cluster` module with worker management.
- **Graceful Shutdown**: Handles system signals (`SIGINT`, `SIGTERM`) and unexpected errors (`unhandledRejection`, `uncaughtException`) to support a graceful shutdown.
- **Service Locator**: Locate and initialize services based on configuration.
- **Bootstrap Support**: Initialize resources and services based on configurations.
- **Configuration Manager**: Manage configurations for different environments or branches.

---

## Installation

```bash
npm install @superhero/core
```

---

## Usage

### Basic Example

```javascript
import Core from '@superhero/core'

const core = new Core()

// Add configuration paths
await core.add('./path/to/config.json')

// Bootstrap core
await core.bootstrap()

// Locate a service
const myService = core.locate('myService')
console.log(myService)

// Graceful shutdown
await core.destruct()
```

### Clustering Example

```javascript
import Core from '@superhero/core'

const core = new Core()

// Cluster into 4 workers
await core.cluster(4)

// Add configuration paths
await core.add('./path/to/config.js')

// Bootstrap core
await core.bootstrap()

// Destruct core when done
await core.destruct()
```

---

## Configuration

The core reads configurations from JSON files and supports environment-specific overrides. Example structure:

`config.json`:
```json
{
  "bootstrap": { "myService": true },
  "locator": { "myService": "./path/to/myService.js" }
}
```

`config-dev.json`:
```json
{
  "myService": { "debug": true }
}
```

---

## Testing

### Prerequisites

Ensure the required dependencies are installed:

```bash
npm install
```

### Run Tests

```bash
npm test
```

### Test Coverage

```
▶ @superhero/core
  ✔ Plain core bootstrap (2.792737ms)
  ✔ Bootstraps a service successfully (9.447829ms)
  ✔ Bootstraps a service with a branch variable (4.01927ms)
  ✔ Can cluster the core and bootstrap a service (479.701512ms)
✔ @superhero/core (511.980508ms)

tests 4
pass 4

---------------------------------------------------------------------------------------------------
file            | line % | branch % | funcs % | uncovered lines
---------------------------------------------------------------------------------------------------
index.js        |  74.64 |    67.42 |   76.00 | 103-106 125-127 135-140 143-145 189-194 205-210 2…
index.test.js   | 100.00 |   100.00 |  100.00 | 
worker.js       | 100.00 |   100.00 |  100.00 | 
---------------------------------------------------------------------------------------------------
all files       |  77.97 |    70.41 |   78.95 | 
---------------------------------------------------------------------------------------------------
```

---

## API

### Core

#### Constructor

```javascript
new Core(branch: string = undefined)
```
- `branch`: The configuration branch to load additional configurations (e.g., `dev` for `config-dev.json`).

#### Methods

- **`add(configPaths: string | string[] | object): Promise<Core>`**  
  Add configuration paths to the core.

- **`bootstrap(freeze: boolean = true): Promise<Core>`**  
  Initialize the core and its dependencies.

- **`cluster(forks: number, branch?: number, version?: number): Promise<number>`**  
  Start clustering with the specified number of workers.

- **`destruct(): Promise<void>`**  
  Gracefully shutdown the core, its workers, and services.

#### Properties

- **`basePath: string`**  
  The base path used to resolve file paths.

- **`branch: string`**  
  The branch used for environment-specific configurations.

- **`workers: object`**  
  Access to clustered workers.

---

## License
This project is licensed under the MIT License.

---

## Contributing
Feel free to submit issues or pull requests for improvements or additional features.
