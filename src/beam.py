"""Background-corrected second-moment beam analysis; units are pixels."""
import argparse,json
from pathlib import Path
import numpy as np

def analyze(image,background=0):
    image=np.asarray(image,dtype=float)
    if image.ndim!=2 or not np.isfinite(image).all(): raise ValueError('Expected finite 2D image')
    signal=np.maximum(image-background,0);power=signal.sum()
    if power<=0: raise ValueError('No positive signal after background correction')
    y,x=np.indices(signal.shape)
    cx=float((signal*x).sum()/power);cy=float((signal*y).sum()/power)
    dx=x-cx;dy=y-cy
    covariance=np.array([[(signal*dx*dx).sum(),(signal*dx*dy).sum()],[(signal*dx*dy).sum(),(signal*dy*dy).sum()]])/power
    values,vectors=np.linalg.eigh(covariance)
    return {'centroid_px':[cx,cy],'d4sigma_axes_px':(4*np.sqrt(np.maximum(values,0))).tolist(),'major_axis_angle_deg':float(np.degrees(np.arctan2(vectors[1,-1],vectors[0,-1]))),'integrated_signal':float(power),'covariance_px2':covariance.tolist()}

def sample():
    y,x=np.mgrid[:220,:300];angle=.4
    u=(x-146)*np.cos(angle)+(y-104)*np.sin(angle)
    v=-(x-146)*np.sin(angle)+(y-104)*np.cos(angle)
    return 3+100*np.exp(-.5*((u/25)**2+(v/14)**2))

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path);p.add_argument('--background',type=float,default=3);p.add_argument('--output',type=Path,default=Path('artifacts'));args=p.parse_args()
    image=np.load(args.input,allow_pickle=False) if args.input else sample()
    result=analyze(image,args.background);args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'measurement.json').write_text(json.dumps(result,indent=2))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.patches import Ellipse
    fig,ax=plt.subplots(figsize=(10,6),layout='constrained');ax.imshow(image,cmap='magma')
    minor,major=result['d4sigma_axes_px'];cx,cy=result['centroid_px']
    ax.add_patch(Ellipse((cx,cy),major,minor,angle=result['major_axis_angle_deg'],fill=False,color='cyan'))
    ax.plot(cx,cy,'c+');ax.set(title='Second-moment beam analysis'+(' — synthetic demo' if not args.input else ''),xlabel='x (px)',ylabel='y (px)')
    fig.savefig(args.output/'result.png',dpi=150);plt.close(fig);print(json.dumps(result,indent=2))
if __name__=='__main__':main()
