import { availableParallelism } from 'node:os'

import { capFor } from './cap.ts'

process.stdout.write(String(capFor(availableParallelism())))
