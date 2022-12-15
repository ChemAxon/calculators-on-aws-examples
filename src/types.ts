export type StructureRecord = {
    id: string,
    mol: string
}

export type DbRecord = {
    id: string,
    mol: string,
    cns_mpo_score: number,
    cns_mpo_props: { [key: string]: { value: number, score: number } }
}
