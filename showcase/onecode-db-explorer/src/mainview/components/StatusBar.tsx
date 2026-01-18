type StatusBarProps = {
  connectionLabel: string;
  tableCount: number;
  bottomStats: string;
};

export default function StatusBar(props: StatusBarProps) {
  return (
    <div class="statusbar">
      <div class="status-left">
        <span>Connection</span>
        <span class="kbd">{props.connectionLabel}</span>
        <span class="pill">{props.tableCount} tables</span>
      </div>
      <div class="status-right">
        <span>{props.bottomStats}</span>
      </div>
    </div>
  );
}
