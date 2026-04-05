use libp2p::{SwarmBuilder, identity, tcp, noise, yamux};
fn test() -> Result<(), Box<dyn std::error::Error>> {
    let keypair = identity::Keypair::generate_ed25519();
    let x = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_relay_client(noise::Config::new, yamux::Config::default);
    Ok(())
}
