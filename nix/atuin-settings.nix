{
  auto_sync = true;
  daemon = {
    autostart = true;
    enabled = true;
  };
  output.enabled = true;
  pty_proxy.enabled = true;
  sync.records = true;
  threads = {
    capture = true;
    capture_tools = true;
  };
}
