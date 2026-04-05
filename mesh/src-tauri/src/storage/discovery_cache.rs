use crate::storage::Database;

impl Database {
    pub fn get_cached_discoveries_for_all_communities(
        &self,
    ) -> anyhow::Result<Vec<(String, String, Vec<String>)>> {
        let communities = self.get_communities()?;
        let mut cached = Vec::new();

        for community in communities {
            for (peer_id, addrs) in self.get_cached_discoveries(&community.id)? {
                cached.push((community.id.clone(), peer_id, addrs));
            }
        }

        Ok(cached)
    }
}
