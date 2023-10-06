export type RawCsvRecord = {
  _1: string,
  _2: string
}

export type StructureRecord = {
    id: string,
    mol: string
}

export type CnsMpoProps = {
    name: string,
    value: number,
    score: number
}

export type CnsMpoResult = {
    'cns-mpo': {
        score?: number,
        properties?: CnsMpoProps[]
        error?: {
            type: string,
            message: string
        }
    }
}

export type CnsMpoResponse = {
    results: CnsMpoResult[]
}

export type DbRecord = {
    id: string,
    mol: string,
    cns_mpo_score: number,
    cns_mpo_props: CnsMpoProps[]
}
